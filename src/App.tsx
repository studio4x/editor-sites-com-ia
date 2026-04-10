import React, { useState, useEffect, useRef } from 'react';
import { 
  Github, 
  Layout, 
  Send, 
  CheckCircle2, 
  AlertCircle, 
  Loader2, 
  LogOut, 
  ChevronRight, 
  Sparkles,
  ArrowLeft,
  MessageCircle,
  X,
  RefreshCw,
  Globe,
  History,
  RotateCcw,
  Menu,
  ChevronLeft,
  Users,
  Settings,
  Plus
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from './lib/utils';
import { auth, db, secondaryAuth } from './firebase';
import { signInWithPopup, GoogleAuthProvider, signInWithEmailAndPassword, signOut, onAuthStateChanged, createUserWithEmailAndPassword } from 'firebase/auth';
import { doc, getDoc, setDoc, collection, getDocs, updateDoc } from 'firebase/firestore';
import ReactMarkdown from 'react-markdown';

// Types for Gemini
type GoogleGenAI = any;

const decodeBase64UTF8 = (base64: string) => {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
  }
  return new TextDecoder('utf-8').decode(bytes);
};

interface Repo {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  description: string;
  html_url: string;
}

interface Commit {
  sha: string;
  commit: {
    message: string;
    author: { name: string; date: string };
  };
}

interface UserData {
  uid: string;
  email: string;
  role: 'admin' | 'client';
  name: string;
  allowedRepos: string[];
}

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [user, setUser] = useState<any>(null);
  const [userData, setUserData] = useState<UserData | null>(null);
  const [isGithubConnected, setIsGithubConnected] = useState(false);
  
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<Repo | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState<{ type: 'success' | 'error', message: string } | null>(null);

  // Admin Panel State
  const [isAdminPanelOpen, setIsAdminPanelOpen] = useState(false);
  const [clients, setClients] = useState<UserData[]>([]);
  const [isCreatingClient, setIsCreatingClient] = useState(false);
  const [editingClient, setEditingClient] = useState<UserData | null>(null);
  const [newClient, setNewClient] = useState({ name: '', email: '', password: '', allowedRepos: [] as string[] });

  // New state for the requested workflow
  const [siteUrl, setSiteUrl] = useState('');
  const [iframeUrl, setIframeUrl] = useState('');
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<{role: 'user' | 'ai', text: string}[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [pendingAction, setPendingAction] = useState<{ userMsg: string, currentContent: string, sha: string } | null>(null);
  
  // History state
  const [history, setHistory] = useState<Commit[]>([]);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isReverting, setIsReverting] = useState(false);

  // Sidebar state
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        try {
          const userDoc = await getDoc(doc(db, 'users', currentUser.uid));
          if (userDoc.exists()) {
            setUserData(userDoc.data() as UserData);
          } else {
            // Se for o admin inicial (agenciastudio4x@gmail.com)
            if (currentUser.email === 'agenciastudio4x@gmail.com') {
              const newAdmin: UserData = {
                uid: currentUser.uid,
                email: currentUser.email,
                role: 'admin',
                name: currentUser.displayName || 'Admin',
                allowedRepos: []
              };
              await setDoc(doc(db, 'users', currentUser.uid), newAdmin);
              setUserData(newAdmin);
            } else {
              // Usuário sem permissão
              setUserData({
                uid: currentUser.uid,
                email: currentUser.email || '',
                role: 'client',
                name: currentUser.displayName || 'Cliente',
                allowedRepos: []
              });
            }
          }
          setIsAuthenticated(true);
        } catch (error) {
          console.error("Erro ao buscar dados do usuário:", error);
          setIsAuthenticated(true); // Ainda autenticado, mas sem dados
        }
      } else {
        setIsAuthenticated(false);
        setUserData(null);
      }
    });

    const handleMessage = async (event: MessageEvent) => {
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS') {
        if (event.data.token && event.data.token !== 'undefined') {
          // Se for admin, salva o token no backend
          if (auth.currentUser) {
            const idToken = await auth.currentUser.getIdToken();
            try {
              const res = await fetch('/api/admin/save-github-token', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${idToken}`
                },
                body: JSON.stringify({ token: event.data.token })
              });
              if (!res.ok) {
                const data = await res.json();
                console.error("Save token error details:", data);
                throw new Error(data.details || data.error || 'Failed to save token');
              }
              setIsGithubConnected(true);
              setStatus({ type: 'success', message: 'Conectado com sucesso ao GitHub!' });
              fetchRepos();
            } catch (error: any) {
              console.error("Erro ao salvar token do GitHub:", error);
              setStatus({ type: 'error', message: `Erro ao salvar token: ${error.message}` });
            }
          }
        } else {
          setStatus({ type: 'error', message: 'Token inválido recebido do GitHub.' });
        }
      } else if (event.data?.type === 'OAUTH_AUTH_ERROR') {
        setStatus({ type: 'error', message: `Erro ao conectar GitHub: ${event.data.error}` });
      }
    };
    
    window.addEventListener('message', handleMessage);
    return () => {
      unsubscribe();
      window.removeEventListener('message', handleMessage);
    };
  }, []);

  useEffect(() => {
    if (isAuthenticated && userData) {
      const isAdminRoute = window.location.pathname === '/admin';
      
      if (userData.role === 'admin' && !isAdminRoute) {
        window.history.replaceState(null, '', '/admin');
      } else if (userData.role === 'client' && isAdminRoute) {
        window.history.replaceState(null, '', '/');
      }

      const checkStatusAndFetch = async () => {
        try {
          const headers = await getAuthHeaders();
          const res = await fetch('/api/github/status', { headers });
          const data = await res.json();
          setIsGithubConnected(data.connected);
          
          if (data.connected) {
            fetchRepos();
          }
          if (userData.role === 'admin') {
            fetchClients();
          }
        } catch (error) {
          console.error("Erro ao verificar status do GitHub:", error);
        }
      };

      checkStatusAndFetch();
    }
  }, [isAuthenticated, userData]);

  const fetchClients = async () => {
    try {
      const querySnapshot = await getDocs(collection(db, 'users'));
      const clientsList: UserData[] = [];
      querySnapshot.forEach((doc) => {
        const data = doc.data() as UserData;
        if (data.role === 'client') {
          clientsList.push(data);
        }
      });
      setClients(clientsList);
    } catch (error) {
      console.error("Erro ao buscar clientes:", error);
    }
  };

  const getAuthHeaders = async () => {
    if (!auth.currentUser) return {};
    const idToken = await auth.currentUser.getIdToken();
    return { 'Authorization': `Bearer ${idToken}` };
  };

  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages]);

  useEffect(() => {
    if (selectedRepo) {
      const fetchRepoUrl = async () => {
        try {
          const headers = await getAuthHeaders();
          const res = await fetch(`/api/repos/${selectedRepo.owner.login}/${selectedRepo.name}/url`, { headers });
          if (res.ok) {
            const data = await res.json();
            if (data.url) {
              setSiteUrl(data.url);
            } else {
              setSiteUrl('');
            }
          }
        } catch (error) {
          console.error('Error fetching repo url:', error);
          setSiteUrl('');
        }
      };
      
      fetchRepoUrl();
      setIframeUrl('');
      setChatMessages([]);
      setIsChatOpen(false);
      setPendingAction(null);
      setIsHistoryOpen(false);
    }
  }, [selectedRepo]);

  const handleUpdateClientRepos = async (clientUid: string, allowedRepos: string[]) => {
    try {
      await updateDoc(doc(db, 'users', clientUid), { allowedRepos });
      setClients(prev => prev.map(c => c.uid === clientUid ? { ...c, allowedRepos } : c));
      setStatus({ type: 'success', message: 'Permissões do cliente atualizadas!' });
      setEditingClient(null);
    } catch (error: any) {
      console.error("Erro ao atualizar cliente:", error);
      setStatus({ type: 'error', message: 'Erro ao atualizar permissões do cliente' });
    }
  };

  const handleCreateClient = async () => {
    if (!newClient.email || !newClient.password) return;
    
    try {
      // Cria o usuário no secondary auth para não deslogar o admin
      const userCredential = await createUserWithEmailAndPassword(secondaryAuth, newClient.email, newClient.password);
      
      const clientData: UserData = {
        uid: userCredential.user.uid,
        email: newClient.email,
        name: newClient.name || 'Cliente',
        role: 'client',
        allowedRepos: newClient.allowedRepos
      };

      // Salva no Firestore
      await setDoc(doc(db, 'users', userCredential.user.uid), clientData);
      
      // Desloga do secondary auth
      await signOut(secondaryAuth);
      
      // Atualiza a lista
      setClients(prev => [...prev, clientData]);
      setIsCreatingClient(false);
      setNewClient({ name: '', email: '', password: '', allowedRepos: [] });
      setStatus({ type: 'success', message: 'Cliente criado com sucesso!' });
    } catch (error: any) {
      console.error("Erro ao criar cliente:", error);
      let errorMsg = error.message || 'Erro ao criar cliente';
      if (error.code === 'auth/operation-not-allowed') {
        errorMsg = 'Erro: A autenticação por E-mail/Senha não está ativada no Firebase. Vá no Console do Firebase > Authentication > Sign-in method e ative "Email/Password".';
      }
      setStatus({ type: 'error', message: errorMsg });
    }
  };

  const handleGoogleLogin = async () => {
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
    } catch (error: any) {
      console.error('Google login error:', error);
      setStatus({ type: 'error', message: error.message || 'Erro ao fazer login com Google' });
    }
  };

  const handleEmailLogin = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const email = formData.get('email') as string;
    const password = formData.get('password') as string;
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (error: any) {
      console.error('Email login error:', error);
      setStatus({ type: 'error', message: 'Email ou senha incorretos' });
    }
  };

  const handleGithubConnect = async () => {
    setStatus(null);
    try {
      const res = await fetch('/api/auth/github/url');
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Falha ao obter URL de autenticação');
      }
      const { url } = await res.json();
      
      const authWindow = window.open(url, 'github_oauth', 'width=600,height=700');
      
      if (!authWindow) {
        setStatus({ type: 'error', message: 'O pop-up de login foi bloqueado pelo seu navegador. Por favor, permita pop-ups para este site.' });
        return;
      }
    } catch (error: any) {
      console.error('GitHub connect error:', error);
      setStatus({ type: 'error', message: error.message || 'Erro ao conectar GitHub' });
    }
  };

  const handleLogout = async () => {
    await signOut(auth);
    setIsAuthenticated(false);
    setUserData(null);
    setSelectedRepo(null);
    setRepos([]);
    setSiteUrl('');
    setIframeUrl('');
    setChatMessages([]);
  };

  const fetchRepos = async () => {
    setIsLoading(true);
    setStatus(null);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch('/api/github/repos', {
        headers
      });
      const data = await res.json();
      
      if (!res.ok) {
        if (res.status === 401 && userData?.role === 'admin') {
          console.error("Auth error details:", data);
          setIsGithubConnected(false);
        }
        throw new Error(data.details || data.error || 'Erro ao buscar repositórios');
      }
      
      setRepos(Array.isArray(data) ? data : []);
      if (Array.isArray(data) && data.length === 0) {
        setStatus({ type: 'error', message: 'Nenhum repositório encontrado.' });
      }
    } catch (error: any) {
      console.error('Fetch repos error:', error);
      setStatus({ type: 'error', message: error.message || 'Erro ao buscar repositórios' });
    } finally {
      setIsLoading(false);
    }
  };

  const fetchHistory = async () => {
    if (!selectedRepo) return;
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`/api/github/history?owner=${selectedRepo.owner.login}&repo=${selectedRepo.name}&path=index.html`, {
        headers
      });
      if (res.ok) {
        const data = await res.json();
        setHistory(Array.isArray(data) ? data : []);
      }
    } catch (error) {
      console.error('Error fetching history:', error);
    }
  };

  const handleRevert = async (commitSha: string) => {
    if (!selectedRepo) return;
    setIsReverting(true);
    try {
      const headers = await getAuthHeaders();
      // 1. Fetch old content
      const res = await fetch(`/api/github/contents?owner=${selectedRepo.owner.login}&repo=${selectedRepo.name}&path=index.html&ref=${commitSha}`, {
        headers
      });
      if (!res.ok) throw new Error('Falha ao buscar versão anterior');
      const data = await res.json();
      const oldContent = decodeBase64UTF8(data.content.replace(/\\n/g, ''));

      // 2. Fetch current sha (to overwrite)
      const currentRes = await fetch(`/api/github/contents?owner=${selectedRepo.owner.login}&repo=${selectedRepo.name}&path=index.html`, {
        headers
      });
      if (!currentRes.ok) throw new Error('Falha ao buscar versão atual');
      const currentData = await currentRes.json();
      const currentSha = currentData.sha;

      // 3. Commit old content as new
      const commitRes = await fetch('/api/github/commit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers
        },
        body: JSON.stringify({
          owner: selectedRepo.owner.login,
          repo: selectedRepo.name,
          path: 'index.html',
          content: oldContent,
          message: `Revert to previous version (${commitSha.substring(0, 7)})`,
          sha: currentSha
        })
      });

      if (!commitRes.ok) throw new Error('Falha ao reverter (commit)');

      setChatMessages(prev => [...prev, { role: 'ai', text: `Site revertido para a versão anterior com sucesso! Atualizando a visualização...` }]);
      
      setTimeout(() => {
        refreshIframe();
      }, 3000);
      
      fetchHistory();
      setIsHistoryOpen(false);
    } catch (error) {
      console.error(error);
      setChatMessages(prev => [...prev, { role: 'ai', text: 'Desculpe, ocorreu um erro ao tentar reverter a versão.' }]);
    } finally {
      setIsReverting(false);
    }
  };

  const handleLoadUrl = async () => {
    if (!siteUrl || !selectedRepo) return;
    const url = siteUrl.startsWith('http') ? siteUrl : `https://${siteUrl}`;
    
    // Save URL for this specific repo in backend
    try {
      const headers = await getAuthHeaders();
      await fetch(`/api/repos/${selectedRepo.owner.login}/${selectedRepo.name}/url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers
        },
        body: JSON.stringify({ url: siteUrl })
      });
    } catch (error) {
      console.error('Error saving repo url:', error);
    }
    
    setIframeUrl(url);
    if (chatMessages.length === 0) {
      setChatMessages([{ role: 'ai', text: 'Olá! Site carregado. O que você gostaria de alterar?' }]);
      setIsChatOpen(true);
    }
    fetchHistory();
  };

  const refreshIframe = () => {
    if (!siteUrl) return;
    const urlObj = new URL(siteUrl.startsWith('http') ? siteUrl : `https://${siteUrl}`);
    urlObj.searchParams.set('t', Date.now().toString());
    setIframeUrl(urlObj.toString());
  };

  const handleSendMessage = async (overrideMsg?: string) => {
    const msgToSend = overrideMsg || chatInput;
    if (!msgToSend.trim() || !selectedRepo) return;

    const userMsg = msgToSend;
    if (!overrideMsg) setChatInput('');
    
    setChatMessages(prev => [...prev, { role: 'user', text: userMsg }]);
    setIsProcessing(true);

    try {
      if (pendingAction) {
        // Estamos aguardando confirmação
        const confirmPrompt = `
          O usuário respondeu: "${userMsg}".
          Isso é uma confirmação para prosseguir com a alteração solicitada anteriormente?
          Responda APENAS "SIM" se for uma confirmação ou concordância (ex: sim, ok, pode fazer, manda ver, yes).
          Responda APENAS "NAO" se for uma negação, cancelamento ou pedido de mudança (ex: não, cancela, espera, mude para azul).
        `;
        const confirmRes = await fetch('/api/gemini/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: confirmPrompt })
        });
        
        if (!confirmRes.ok) throw new Error('Erro ao verificar confirmação');
        const { text: confirmText } = await confirmRes.json();
        
        if (confirmText.trim().toUpperCase().includes('SIM')) {
          setChatMessages(prev => [...prev, { role: 'ai', text: 'Entendido! Gerando e aplicando as alterações...' }]);
          
          // Prossegue com a geração do código
          const generatePrompt = `
            Você é um desenvolvedor web especialista em HTML, CSS e JS.
            Aqui está o conteúdo atual do arquivo 'index.html' do repositório:
            
            \`\`\`html
            ${pendingAction.currentContent}
            \`\`\`
            
            O usuário solicitou a seguinte alteração: "${pendingAction.userMsg}"
            
            INSTRUÇÃO OBRIGATÓRIA: SEMPRE PRESERVE A CODIFICAÇÃO DOS TEXTOS QUANDO REALIZAR UMA ATUALIZAÇÃO. A CODIFICAÇÃO PADRÃO É AQUELA QUE CONTÉM ACENTUAÇÃO NAS PALAVRAS. Não altere os caracteres especiais ou acentos já existentes no código.
            
            Retorne APENAS o código HTML completo e atualizado. Não inclua explicações, markdown ou blocos de código (\`\`\`). Apenas o código puro.
          `;

          const aiRes = await fetch('/api/gemini/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: generatePrompt })
          });

          if (!aiRes.ok) throw new Error('Erro ao gerar código com a IA');
          const { text } = await aiRes.json();
          const updatedContent = text.replace(/^```html\n?/, '').replace(/\n?```$/, '').trim();

          // Commit no GitHub
          const headers = await getAuthHeaders();
          const commitRes = await fetch('/api/github/commit', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...headers
            },
            body: JSON.stringify({
              owner: selectedRepo.owner.login,
              repo: selectedRepo.name,
              path: 'index.html',
              content: updatedContent,
              message: `AI Update: ${pendingAction.userMsg}`,
              sha: pendingAction.sha || undefined
            })
          });

          if (!commitRes.ok) throw new Error('Falha ao fazer commit');

          setChatMessages(prev => [...prev, { role: 'ai', text: 'Alteração concluída e enviada para o site! Atualizando a visualização em instantes...' }]);
          
          // Aguarda 5 segundos para dar tempo do servidor/CDN processar a mudança
          // Tentamos atualizar algumas vezes para garantir
          setTimeout(() => refreshIframe(), 3000);
          setTimeout(() => refreshIframe(), 6000);
          setTimeout(() => refreshIframe(), 10000);
          
          fetchHistory();
          setPendingAction(null);
        } else {
          // Cancelado ou mudou de ideia
          setPendingAction(null);
          setChatMessages(prev => [...prev, { role: 'ai', text: 'Operação cancelada. O que mais você gostaria de fazer ou como prefere ajustar o pedido?' }]);
        }
      } else {
        // Passo 1: Buscar o index.html atual
        const headers = await getAuthHeaders();
        const res = await fetch(`/api/github/contents?owner=${selectedRepo.owner.login}&repo=${selectedRepo.name}&path=index.html`, {
          headers
        });
        
        let currentContent = '';
        let sha = '';
        
        if (res.ok) {
          const data = await res.json();
          currentContent = decodeBase64UTF8(data.content.replace(/\\n/g, ''));
          sha = data.sha;
        } else {
          currentContent = '<!DOCTYPE html>\n<html>\n<head>\n<title>Meu Site</title>\n</head>\n<body>\n</body>\n</html>';
        }

        // Passo 2: Pedir para a IA explicar a mudança
        const explainPrompt = `
          O usuário pediu a seguinte alteração no site: "${userMsg}"
          
          O código atual do site é:
          \`\`\`html
          ${currentContent}
          \`\`\`
          
          Explique de forma breve, clara e amigável o que você vai alterar no código para atender a esse pedido.
          Ao final, pergunte se o usuário deseja confirmar a alteração (ex: "Posso prosseguir com essas alterações?").
          NÃO retorne código HTML agora, apenas a explicação em texto.
        `;

        const aiRes = await fetch('/api/gemini/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: explainPrompt })
        });

        if (!aiRes.ok) throw new Error('Erro ao gerar explicação com a IA');
        const { text } = await aiRes.json();

        setChatMessages(prev => [...prev, { role: 'ai', text }]);
        setPendingAction({ userMsg, currentContent, sha });
      }

    } catch (error) {
      console.error(error);
      setChatMessages(prev => [...prev, { role: 'ai', text: 'Desculpe, ocorreu um erro ao processar sua solicitação.' }]);
      setPendingAction(null);
    } finally {
      setIsProcessing(false);
    }
  };

  if (isAuthenticated === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-50">
        <Loader2 className="w-8 h-8 animate-spin text-zinc-400" />
      </div>
    );
  }

  if (!isAuthenticated) {
    const isAdminRoute = window.location.pathname === '/admin';
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-zinc-50 p-4">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-md w-full glass p-8 rounded-3xl shadow-xl text-center"
        >
          <div className="w-16 h-16 bg-zinc-900 rounded-2xl flex items-center justify-center mx-auto mb-6">
            <Sparkles className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-3xl font-bold mb-2 tracking-tight">
            {isAdminRoute ? 'Acesso Administrativo' : 'Acesso do Cliente'}
          </h1>
          <p className="text-zinc-500 mb-8">
            {isAdminRoute ? 'Faça login com sua conta Google para gerenciar a plataforma.' : 'Faça login com seu e-mail e senha para acessar seus sites.'}
          </p>

          {status && (
            <div className={cn("p-3 rounded-lg text-sm mb-6 flex items-center gap-2", status.type === 'error' ? "bg-red-50 text-red-600" : "bg-green-50 text-green-600")}>
              {status.type === 'error' ? <AlertCircle className="w-4 h-4 shrink-0" /> : <CheckCircle2 className="w-4 h-4 shrink-0" />}
              <span className="text-left">{status.message}</span>
            </div>
          )}

          {!isAdminRoute ? (
            <form onSubmit={handleEmailLogin} className="space-y-4 mb-6">
              <div>
                <input 
                  type="email" 
                  name="email" 
                  placeholder="Seu e-mail" 
                  required 
                  className="w-full px-4 py-3 bg-white border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900/5 focus:border-zinc-900 transition-all text-left"
                />
              </div>
              <div>
                <input 
                  type="password" 
                  name="password" 
                  placeholder="Sua senha" 
                  required 
                  className="w-full px-4 py-3 bg-white border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900/5 focus:border-zinc-900 transition-all text-left"
                />
              </div>
              <button 
                type="submit"
                className="w-full py-3 bg-zinc-900 text-white rounded-xl font-medium hover:bg-zinc-800 transition-all active:scale-[0.98]"
              >
                Entrar
              </button>
            </form>
          ) : (
            <button 
              onClick={handleGoogleLogin}
              className="w-full flex items-center justify-center gap-3 bg-white border border-zinc-200 text-zinc-700 py-3 rounded-xl font-medium hover:bg-zinc-50 transition-all active:scale-[0.98]"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              Entrar com Google
            </button>
          )}
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex bg-zinc-50 overflow-hidden">
      {/* Sidebar Overlay for mobile */}
      {isSidebarOpen && (
        <div 
          className="fixed inset-0 bg-black/20 z-30 md:hidden"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside 
        className={cn(
          "fixed md:relative z-40 h-full bg-white border-r border-zinc-200 flex flex-col transition-all duration-300 ease-in-out overflow-hidden shrink-0",
          isSidebarOpen ? "w-80 translate-x-0" : "w-0 -translate-x-full md:translate-x-0 border-none"
        )}
      >
        <div className="w-80 h-full flex flex-col">
          <div className="p-6 border-b border-zinc-100 flex items-center justify-between">
            <div className="flex items-center gap-2 font-bold text-xl tracking-tight">
              <Sparkles className="w-5 h-5 text-zinc-900" />
              <span>Editor de Sites com IA</span>
            </div>
            <div className="flex items-center gap-1">
              <button 
                onClick={handleLogout}
                className="p-2 text-zinc-400 hover:text-zinc-900 transition-colors"
                title="Sair"
              >
                <LogOut className="w-5 h-5" />
              </button>
              <button 
                onClick={() => setIsSidebarOpen(false)}
                className="p-2 text-zinc-400 hover:text-zinc-900 transition-colors"
                title="Recolher Menu"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto custom-scrollbar p-4">
            {status && (
              <div className={cn("p-3 rounded-lg text-sm mb-4 flex items-start gap-2", status.type === 'error' ? "bg-red-50 text-red-600" : "bg-green-50 text-green-600")}>
                {status.type === 'error' ? <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> : <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />}
                <span className="text-left flex-1">{status.message}</span>
                <button onClick={() => setStatus(null)} className="shrink-0 p-0.5 hover:bg-black/5 rounded"><X className="w-4 h-4"/></button>
              </div>
            )}

            {userData?.role === 'admin' && (
              <div className="mb-6 space-y-2">
                {!isGithubConnected && (
                  <button 
                    onClick={handleGithubConnect}
                    className="w-full flex items-center gap-3 p-3 bg-zinc-900 text-white rounded-xl hover:bg-zinc-800 transition-colors text-sm font-medium"
                  >
                    <Github className="w-4 h-4" />
                    Conectar GitHub
                  </button>
                )}
                <button
                  onClick={() => {
                    setIsAdminPanelOpen(!isAdminPanelOpen);
                    setSelectedRepo(null);
                  }}
                  className={cn(
                    "w-full flex items-center gap-3 p-3 rounded-xl transition-colors text-sm font-medium",
                    isAdminPanelOpen ? "bg-zinc-100 text-zinc-900" : "bg-white border border-zinc-200 text-zinc-700 hover:bg-zinc-50"
                  )}
                >
                  <Users className="w-4 h-4" />
                  Painel de Clientes
                </button>
              </div>
            )}

            {isAdminPanelOpen ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between px-2">
                  <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Clientes</h2>
                  <button 
                    onClick={() => setIsCreatingClient(true)}
                    className="p-1 hover:bg-zinc-100 rounded-md transition-colors text-zinc-500"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>

                {isCreatingClient && (
                  <div className="p-4 bg-zinc-50 rounded-xl border border-zinc-200 space-y-3">
                    <h3 className="text-sm font-medium">Novo Cliente</h3>
                    <input 
                      type="text" 
                      placeholder="Nome" 
                      value={newClient.name}
                      onChange={e => setNewClient({...newClient, name: e.target.value})}
                      className="w-full px-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-zinc-900/5"
                    />
                    <input 
                      type="email" 
                      placeholder="E-mail" 
                      value={newClient.email}
                      onChange={e => setNewClient({...newClient, email: e.target.value})}
                      className="w-full px-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-zinc-900/5"
                    />
                    <input 
                      type="password" 
                      placeholder="Senha" 
                      value={newClient.password}
                      onChange={e => setNewClient({...newClient, password: e.target.value})}
                      className="w-full px-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-zinc-900/5"
                    />
                    <div className="space-y-2">
                      <p className="text-xs text-zinc-500">Repositórios Permitidos:</p>
                      <div className="max-h-32 overflow-y-auto space-y-1">
                        {repos.map(repo => (
                          <label key={repo.id} className="flex items-center gap-2 text-xs">
                            <input 
                              type="checkbox" 
                              checked={newClient.allowedRepos.includes(repo.full_name)}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setNewClient({...newClient, allowedRepos: [...newClient.allowedRepos, repo.full_name]});
                                } else {
                                  setNewClient({...newClient, allowedRepos: newClient.allowedRepos.filter(r => r !== repo.full_name)});
                                }
                              }}
                            />
                            <span className="truncate">{repo.full_name}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                    <div className="flex gap-2 pt-2">
                      <button 
                        onClick={() => setIsCreatingClient(false)}
                        className="flex-1 py-2 text-xs font-medium text-zinc-500 hover:bg-zinc-100 rounded-lg transition-colors"
                      >
                        Cancelar
                      </button>
                      <button 
                        onClick={handleCreateClient}
                        disabled={!newClient.email || !newClient.password}
                        className="flex-1 py-2 text-xs font-medium bg-zinc-900 text-white rounded-lg hover:bg-zinc-800 transition-colors disabled:opacity-50"
                      >
                        Salvar
                      </button>
                    </div>
                  </div>
                )}

                <div className="space-y-2">
                  {clients.map(client => (
                    <div key={client.uid} className="p-3 bg-white border border-zinc-200 rounded-xl text-sm">
                      <div className="flex justify-between items-start mb-1">
                        <div>
                          <p className="font-medium">{client.name}</p>
                          <p className="text-xs text-zinc-500">{client.email}</p>
                        </div>
                        <button 
                          onClick={() => setEditingClient(editingClient?.uid === client.uid ? null : client)}
                          className="p-1 hover:bg-zinc-100 rounded-md transition-colors text-zinc-400 hover:text-zinc-600"
                          title="Editar permissões"
                        >
                          <Settings className="w-4 h-4" />
                        </button>
                      </div>

                      {editingClient?.uid === client.uid ? (
                        <div className="mt-3 pt-3 border-t border-zinc-100 space-y-3">
                          <p className="text-xs font-medium text-zinc-700">Editar Acessos:</p>
                          <div className="max-h-40 overflow-y-auto space-y-1 bg-zinc-50 p-2 rounded-lg">
                            {repos.map(repo => (
                              <label key={repo.id} className="flex items-center gap-2 text-xs">
                                <input 
                                  type="checkbox" 
                                  checked={editingClient.allowedRepos.includes(repo.full_name)}
                                  onChange={(e) => {
                                    const currentRepos = editingClient.allowedRepos;
                                    const newRepos = e.target.checked 
                                      ? [...currentRepos, repo.full_name]
                                      : currentRepos.filter(r => r !== repo.full_name);
                                    setEditingClient({...editingClient, allowedRepos: newRepos});
                                  }}
                                />
                                <span className="truncate">{repo.full_name}</span>
                              </label>
                            ))}
                          </div>
                          <div className="flex gap-2">
                            <button 
                              onClick={() => setEditingClient(null)}
                              className="flex-1 py-1.5 text-xs bg-zinc-100 hover:bg-zinc-200 rounded-lg transition-colors"
                            >
                              Cancelar
                            </button>
                            <button 
                              onClick={() => handleUpdateClientRepos(client.uid, editingClient.allowedRepos)}
                              className="flex-1 py-1.5 text-xs bg-zinc-900 text-white rounded-lg hover:bg-zinc-800 transition-colors"
                            >
                              Salvar
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-1 mt-2">
                          <p className="text-xs font-medium text-zinc-700">Acesso a:</p>
                          {client.allowedRepos.length === 0 ? (
                            <p className="text-xs text-zinc-400">Nenhum repositório</p>
                          ) : (
                            client.allowedRepos.map(repo => (
                              <p key={repo} className="text-xs text-zinc-500 truncate">• {repo}</p>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ) : !selectedRepo ? (
            <div className="space-y-2">
              <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider px-2 mb-4">Seus Repositórios</h2>
              {isLoading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-zinc-300" />
                </div>
              ) : repos.length === 0 ? (
                <div className="text-center py-8 px-4 text-sm text-zinc-500">
                  {userData?.role === 'admin' && !isGithubConnected 
                    ? "Conecte seu GitHub para ver os repositórios." 
                    : "Nenhum repositório disponível."}
                </div>
              ) : (
                repos.map(repo => (
                  <button
                    key={repo.id}
                    onClick={() => setSelectedRepo(repo)}
                    className="w-full text-left p-3 rounded-xl hover:bg-zinc-50 transition-colors group flex items-center gap-3"
                  >
                    <div className="w-10 h-10 bg-zinc-100 rounded-lg flex items-center justify-center group-hover:bg-white transition-colors">
                      <Layout className="w-5 h-5 text-zinc-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate">{repo.name}</p>
                      <p className="text-xs text-zinc-400 truncate">{repo.owner.login}</p>
                    </div>
                    <ChevronRight className="w-4 h-4 text-zinc-300 opacity-0 group-hover:opacity-100 transition-opacity" />
                  </button>
                ))
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-2 mb-2">
                <button 
                  onClick={() => {
                    setSelectedRepo(null);
                    setSiteUrl('');
                    setIframeUrl('');
                  }}
                  className="p-1 hover:bg-zinc-100 rounded-md transition-colors"
                >
                  <ArrowLeft className="w-4 h-4 text-zinc-500" />
                </button>
                <h2 className="text-sm font-bold truncate">{selectedRepo.name}</h2>
              </div>
              
              <div className="p-4 bg-zinc-50 rounded-xl border border-zinc-100">
                <p className="text-xs text-zinc-500 mb-3">
                  Insira a URL do site hospedado para visualizar as alterações em tempo real.
                </p>
                <div className="space-y-2">
                  <div className="relative">
                    <Globe className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      placeholder="ex: meulink.com.br"
                      value={siteUrl}
                      onChange={(e) => setSiteUrl(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleLoadUrl()}
                      className="w-full pl-9 pr-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-zinc-900/5 focus:border-zinc-900 transition-all"
                    />
                  </div>
                  <button
                    onClick={handleLoadUrl}
                    disabled={!siteUrl}
                    className="w-full py-2 bg-zinc-900 text-white text-sm font-medium rounded-lg hover:bg-zinc-800 transition-colors disabled:opacity-50"
                  >
                    Carregar Site
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
        </div>
      </aside>

      {/* Floating Menu Button */}
      {!isSidebarOpen && (
        <button
          onClick={() => setIsSidebarOpen(true)}
          className="fixed bottom-6 left-6 z-50 w-14 h-14 bg-zinc-900 text-white rounded-full flex items-center justify-center shadow-xl hover:bg-zinc-800 transition-all active:scale-95"
          title="Abrir Menu"
        >
          <Menu className="w-6 h-6" />
        </button>
      )}

      {/* Main Content */}
      <main className="flex-1 flex flex-col relative overflow-hidden bg-zinc-100">
        {!iframeUrl ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
            <div className="w-20 h-20 bg-white shadow-sm border border-zinc-100 rounded-3xl flex items-center justify-center mb-6">
              <Globe className="w-10 h-10 text-zinc-300" />
            </div>
            <h2 className="text-2xl font-bold mb-2">Visualização do Site</h2>
            <p className="text-zinc-400 max-w-md">
              Selecione um repositório e insira a URL do site para começar a editar com o assistente de IA.
            </p>
          </div>
        ) : (
          <div className="flex-1 flex flex-col relative">
            {/* Iframe Toolbar */}
            <div className="h-12 bg-white border-b border-zinc-200 flex items-center justify-between px-4">
              <div className="flex items-center gap-2 text-sm text-zinc-500">
                <Globe className="w-4 h-4" />
                <span className="truncate max-w-md">{iframeUrl.split('?')[0]}</span>
              </div>
              <button 
                onClick={refreshIframe}
                className="p-2 hover:bg-zinc-100 rounded-md transition-colors text-zinc-500 flex items-center gap-2 text-xs font-medium"
              >
                <RefreshCw className="w-3 h-3" />
                Atualizar
              </button>
            </div>
            
            {/* Iframe */}
            <iframe 
              src={iframeUrl} 
              className="w-full flex-1 bg-white"
              title="Site Preview"
              sandbox="allow-scripts allow-same-origin allow-forms"
            />
          </div>
        )}

        {/* Floating Chat */}
        {selectedRepo && iframeUrl && (
          <div className="absolute bottom-6 right-6 z-50 flex flex-col items-end">
            <AnimatePresence>
              {isChatOpen && (
                <motion.div
                  initial={{ opacity: 0, y: 20, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 20, scale: 0.95 }}
                  className="w-96 h-[500px] bg-white rounded-2xl shadow-2xl border border-zinc-200 flex flex-col mb-4 overflow-hidden"
                >
                  {/* Chat Header */}
                  <div className="p-4 border-b border-zinc-100 bg-zinc-900 text-white flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Sparkles className="w-4 h-4" />
                      <span className="font-medium text-sm">Assistente IA</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button 
                        onClick={() => setIsHistoryOpen(!isHistoryOpen)}
                        className={cn("p-1.5 rounded-md transition-colors", isHistoryOpen ? "bg-white/20 text-white" : "text-white/70 hover:text-white hover:bg-white/10")}
                        title="Histórico de Alterações"
                      >
                        <History className="w-4 h-4" />
                      </button>
                      <button 
                        onClick={() => setIsChatOpen(false)}
                        className="p-1.5 text-white/70 hover:text-white hover:bg-white/10 rounded-md transition-colors"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {/* Chat Messages or History */}
                  {isHistoryOpen ? (
                    <div className="flex-1 overflow-y-auto p-4 custom-scrollbar bg-zinc-50/50">
                      <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-4">Histórico de Alterações</h3>
                      {history.length === 0 ? (
                        <div className="text-center text-zinc-500 text-sm py-8">
                          Nenhum histórico encontrado.
                        </div>
                      ) : (
                        <div className="space-y-3">
                          {history.map((item, idx) => (
                            <div key={item.sha} className="bg-white border border-zinc-200 rounded-xl p-3 text-sm relative group">
                              <p className="font-medium text-zinc-900 mb-1">{item.commit.message}</p>
                              <div className="flex items-center justify-between text-xs text-zinc-500">
                                <span>{new Date(item.commit.author.date).toLocaleString()}</span>
                                <span>{item.sha.substring(0, 7)}</span>
                              </div>
                              {idx !== 0 && (
                                <button
                                  onClick={() => handleRevert(item.sha)}
                                  disabled={isReverting}
                                  className="absolute top-3 right-3 p-1.5 bg-zinc-100 text-zinc-600 rounded-md opacity-0 group-hover:opacity-100 hover:bg-zinc-200 hover:text-zinc-900 transition-all disabled:opacity-50"
                                  title="Reverter para esta versão"
                                >
                                  <RotateCcw className="w-4 h-4" />
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar bg-zinc-50/50">
                      {chatMessages.map((msg, idx) => (
                        <div 
                          key={idx} 
                          className={cn(
                            "max-w-[85%] rounded-2xl p-3 text-sm",
                            msg.role === 'user' 
                              ? "bg-zinc-900 text-white ml-auto rounded-tr-sm whitespace-pre-wrap" 
                              : "bg-white border border-zinc-200 text-zinc-800 mr-auto rounded-tl-sm markdown-body"
                          )}
                        >
                          {msg.role === 'ai' ? (
                            <ReactMarkdown>{msg.text}</ReactMarkdown>
                          ) : (
                            msg.text
                          )}
                        </div>
                      ))}
                      {isProcessing && (
                        <div className="bg-white border border-zinc-200 text-zinc-800 mr-auto rounded-2xl rounded-tl-sm p-4 flex items-center gap-3">
                          <Loader2 className="w-4 h-4 animate-spin text-zinc-400" />
                          <span className="text-xs text-zinc-500">Processando...</span>
                        </div>
                      )}
                      <div ref={chatEndRef} />
                    </div>
                  )}

                  {/* Chat Input */}
                  {!isHistoryOpen && (
                    <div className="p-3 bg-white border-t border-zinc-100 flex flex-col gap-3">
                      {pendingAction && !isProcessing && (
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleSendMessage('Sim, pode prosseguir')}
                            className="flex-1 bg-green-600 hover:bg-green-700 text-white text-xs font-medium py-2 px-3 rounded-lg transition-colors flex items-center justify-center gap-1.5"
                          >
                            <CheckCircle2 className="w-4 h-4" />
                            Sim, prosseguir
                          </button>
                          <button
                            onClick={() => handleSendMessage('Não, cancelar')}
                            className="flex-1 bg-zinc-100 hover:bg-zinc-200 text-zinc-700 text-xs font-medium py-2 px-3 rounded-lg transition-colors flex items-center justify-center gap-1.5"
                          >
                            <X className="w-4 h-4" />
                            Cancelar
                          </button>
                        </div>
                      )}
                      <div className="relative">
                        <textarea
                          value={chatInput}
                          onChange={(e) => setChatInput(e.target.value)}
                          placeholder="O que deseja alterar no site?"
                          className="w-full bg-zinc-50 border border-zinc-200 rounded-xl p-3 pr-12 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900/5 focus:border-zinc-900 transition-all resize-none h-[80px]"
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault();
                              handleSendMessage();
                            }
                          }}
                        />
                        <button 
                          onClick={() => handleSendMessage()}
                          disabled={isProcessing || !chatInput.trim()}
                          className="absolute bottom-3 right-3 p-2 bg-zinc-900 text-white rounded-lg hover:bg-zinc-800 transition-all disabled:opacity-30 active:scale-95"
                        >
                          <Send className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>

            {/* Chat Toggle Button */}
            <button
              onClick={() => setIsChatOpen(!isChatOpen)}
              className={cn(
                "w-14 h-14 rounded-full flex items-center justify-center shadow-xl transition-all active:scale-95",
                isChatOpen ? "bg-white text-zinc-900 border border-zinc-200" : "bg-zinc-900 text-white hover:bg-zinc-800"
              )}
            >
              {isChatOpen ? <X className="w-6 h-6" /> : <MessageCircle className="w-6 h-6" />}
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
