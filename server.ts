import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import axios from 'axios';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import fs from 'fs';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load Firebase config
const firebaseConfigPath = path.join(process.cwd(), 'firebase-applet-config.json');
let firebaseConfig: any = {};
if (fs.existsSync(firebaseConfigPath)) {
  firebaseConfig = JSON.parse(fs.readFileSync(firebaseConfigPath, 'utf8'));
}

// Initialize Firebase Admin (only for Auth which doesn't need credentials)
if (!getApps().length) {
  initializeApp({
    projectId: firebaseConfig.projectId
  });
}

// Helper to parse Firestore REST API response
const parseFirestoreDocument = (doc: any) => {
  if (!doc || !doc.fields) return {};
  const result: any = {};
  for (const [key, value] of Object.entries(doc.fields)) {
    const type = Object.keys(value as any)[0];
    if (type === 'arrayValue') {
      result[key] = ((value as any).arrayValue.values || []).map((v: any) => v[Object.keys(v)[0]]);
    } else {
      result[key] = (value as any)[type];
    }
  }
  return result;
};

// Helper to fetch doc via REST API using user's ID token
const getFirestoreDocREST = async (collection: string, docId: string, idToken: string) => {
  const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/${firebaseConfig.firestoreDatabaseId || '(default)'}/documents/${collection}/${docId}`;
  try {
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${idToken}` }
    });
    return { exists: true, data: parseFirestoreDocument(response.data) };
  } catch (error: any) {
    if (error.response && error.response.status === 404) {
      return { exists: false, data: null };
    }
    throw error;
  }
};

// Helper to save doc via REST API using user's ID token
const setFirestoreDocREST = async (collection: string, docId: string, data: any, idToken: string) => {
  const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/${firebaseConfig.firestoreDatabaseId || '(default)'}/documents/${collection}/${docId}`;
  
  const fields: any = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string') fields[key] = { stringValue: value };
    else if (typeof value === 'number') fields[key] = { doubleValue: value };
    else if (typeof value === 'boolean') fields[key] = { booleanValue: value };
    else if (Array.isArray(value)) {
      fields[key] = { arrayValue: { values: value.map(v => ({ stringValue: v })) } };
    }
  }

  await axios.patch(url, { fields }, {
    headers: { Authorization: `Bearer ${idToken}` }
  });
};

// Middleware to verify Firebase ID token
const verifyFirebaseToken = async (req: any, res: any, next: any) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }
  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await getAuth().verifyIdToken(idToken);
    req.user = decodedToken;
    req.idToken = idToken; // Save token for REST API calls
    
    // Fetch user role and permissions from Firestore via REST
    const userDoc = await getFirestoreDocREST('users', decodedToken.uid, idToken);
    if (userDoc.exists) {
      req.userData = userDoc.data;
    } else {
      // Default admin check
      if (decodedToken.email === 'agenciastudio4x@gmail.com' && decodedToken.email_verified) {
        req.userData = { role: 'admin' };
      } else {
        req.userData = { role: 'client', allowedRepos: [] };
      }
    }
    next();
  } catch (error: any) {
    console.error('Error verifying Firebase token:', error.response?.data || error.message);
    res.status(401).json({ 
      error: 'Unauthorized', 
      details: error.response?.data?.error?.message || error.message, 
      code: error.code 
    });
  }
};

async function startServer() {
  console.log("Server GEMINI_API_KEY exists:", !!process.env.GEMINI_API_KEY);
  const app = express();
  const PORT = 3000;

  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(cookieParser());
  app.use(session({
    secret: 'github-editor-secret',
    resave: false,
    saveUninitialized: true,
    proxy: true,
    cookie: {
      secure: true,
      sameSite: 'none',
      httpOnly: true,
    }
  }));

  // GitHub OAuth Routes
  app.get('/api/auth/github/url', (req, res) => {
    const clientId = process.env.GITHUB_CLIENT_ID;
    const redirectUri = process.env.GITHUB_REDIRECT_URI || `${process.env.APP_URL}/api/auth/github/callback`;
    
    console.log('Generating Auth URL. ClientID:', !!clientId, 'RedirectURI:', redirectUri);
    
    if (!clientId) {
      return res.status(500).json({ error: 'GITHUB_CLIENT_ID not configured' });
    }

    const url = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=repo,user`;
    res.json({ url });
  });

  app.get('/api/auth/github/callback', async (req, res) => {
    const { code } = req.query;
    console.log('Received GitHub callback with code:', !!code);
    const clientId = process.env.GITHUB_CLIENT_ID;
    const clientSecret = process.env.GITHUB_CLIENT_SECRET;

    try {
      const response = await axios.post('https://github.com/login/oauth/access_token', {
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }, {
        headers: { Accept: 'application/json' }
      });

      console.log('GitHub Token response:', response.data);

      if (response.data.error) {
        throw new Error(response.data.error_description || response.data.error);
      }

      const { access_token } = response.data;
      
      if (!access_token) {
        throw new Error('No access token received from GitHub');
      }

      console.log('GitHub Token received successfully');
      
      // Store token in session as fallback
      (req as any).session.githubToken = access_token;
      console.log('Token stored in session:', !!(req as any).session.githubToken);

      res.send(`
        <html>
          <body>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS', token: '${access_token}' }, '*');
                window.close();
              } else {
                window.location.href = '/';
              }
            </script>
            <p>Autenticação bem-sucedida. Esta janela fechará automaticamente.</p>
          </body>
        </html>
      `);
    } catch (error: any) {
      console.error('GitHub Auth Error:', error.message || error);
      res.status(500).send(`
        <html>
          <body>
            <p>Erro na autenticação com GitHub: ${error.message || 'Erro desconhecido'}</p>
            <script>
              setTimeout(() => {
                if (window.opener) {
                  window.opener.postMessage({ type: 'OAUTH_AUTH_ERROR', error: '${error.message || 'Erro'}' }, '*');
                  window.close();
                }
              }, 3000);
            </script>
          </body>
        </html>
      `);
    }
  });

  app.get('/api/auth/status', (req, res) => {
    res.json({ authenticated: !!(req as any).session.githubToken });
  });

  app.get('/api/auth/logout', (req, res) => {
    (req as any).session.githubToken = null;
    res.json({ success: true });
  });

  app.get('/api/health', async (req, res) => {
    const { loadEnv } = await import('vite');
    const env = loadEnv('development', '.', '');
    const apiKey = process.env.CUSTOM_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
    res.json({ 
      status: 'ok', 
      hasCustomKey: !!process.env.CUSTOM_GEMINI_API_KEY,
      hasGemini: !!apiKey,
      keyPrefix: apiKey ? apiKey.substring(0, 5) : null,
      keyLength: apiKey?.length
    });
  });

  const GITHUB_TOKEN_PATH = path.join(process.cwd(), '.github_token');

  // Admin route to save GitHub token
  app.post('/api/admin/save-github-token', verifyFirebaseToken, async (req: any, res: any) => {
    if (req.userData.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token is required' });
    
    try {
      await setFirestoreDocREST('settings', 'github', { token }, req.idToken);
      res.json({ success: true });
    } catch (error: any) {
      console.error('Error saving GitHub token:', error.message);
      res.status(500).json({ error: 'Failed to save token' });
    }
  });

  const getGithubToken = async (req: any) => {
    try {
      const doc = await getFirestoreDocREST('settings', 'github', req.idToken);
      if (doc.exists && doc.data.token) {
        return doc.data.token;
      }
      return null;
    } catch (error) {
      console.error('Error getting GitHub token:', error);
      return null;
    }
  };

  app.get('/api/github/status', verifyFirebaseToken, async (req: any, res: any) => {
    const token = await getGithubToken(req);
    res.json({ connected: !!token });
  });

  // Proxy routes for GitHub API to keep token secret
  app.get('/api/github/repos', verifyFirebaseToken, async (req: any, res: any) => {
    const token = await getGithubToken(req);
    console.log('Fetching repos. Token present:', !!token);
    
    if (!token) {
      console.log('No token found');
      if (req.userData.role === 'admin') {
        return res.status(401).json({ error: 'Não autenticado no GitHub' });
      } else {
        return res.status(500).json({ error: 'O sistema não está conectado ao GitHub. Contate o administrador.' });
      }
    }

    try {
      console.log('Calling GitHub API...');
      const response = await axios.get('https://api.github.com/user/repos?sort=updated&per_page=100', {
        headers: { 
          Authorization: `Bearer ${token}`,
          'User-Agent': 'AI-Site-Editor'
        }
      });
      console.log(`GitHub API success: found ${response.data.length} repos`);
      
      let repos = response.data;
      if (req.userData.role !== 'admin') {
        const allowed = req.userData.allowedRepos || [];
        repos = repos.filter((r: any) => allowed.includes(r.full_name));
      }
      
      res.json(repos);
    } catch (error: any) {
      console.error('GitHub API Error:', error.response?.status, error.response?.data || error.message);
      res.status(error.response?.status || 500).json(error.response?.data || { error: 'Erro ao buscar repositórios' });
    }
  });

  const checkRepoAccess = (req: any, owner: string, repo: string) => {
    if (req.userData.role === 'admin') return true;
    const fullName = `${owner}/${repo}`;
    return (req.userData.allowedRepos || []).includes(fullName);
  };

  app.get('/api/repos/:owner/:repo/url', verifyFirebaseToken, async (req: any, res: any) => {
    const { owner, repo } = req.params;
    if (!checkRepoAccess(req, owner, repo)) return res.status(403).json({ error: 'Acesso negado a este repositório' });

    try {
      const docId = `${owner}_${repo}`;
      const doc = await getFirestoreDocREST('repo_urls', docId, req.idToken);
      res.json({ url: doc.exists ? doc.data.url : '' });
    } catch (error) {
      console.error('Error getting repo url:', error);
      res.json({ url: '' });
    }
  });

  app.post('/api/repos/:owner/:repo/url', verifyFirebaseToken, async (req: any, res: any) => {
    const { owner, repo } = req.params;
    const { url } = req.body;
    if (!checkRepoAccess(req, owner, repo)) return res.status(403).json({ error: 'Acesso negado a este repositório' });

    try {
      const docId = `${owner}_${repo}`;
      await setFirestoreDocREST('repo_urls', docId, { url }, req.idToken);
      res.json({ success: true });
    } catch (error) {
      console.error('Error saving repo url:', error);
      res.status(500).json({ error: 'Failed to save repo url' });
    }
  });

  app.get('/api/debug/users', async (req, res) => {
    try {
      const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/${firebaseConfig.firestoreDatabaseId || '(default)'}/documents/users`;
      const response = await axios.get(url);
      res.json(response.data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/github/contents', verifyFirebaseToken, async (req: any, res: any) => {
    const token = await getGithubToken(req);
    const { owner, repo, path: filePath, ref } = req.query;
    if (!token) {
      if (req.userData.role === 'admin') return res.status(401).json({ error: 'Não autenticado no GitHub' });
      return res.status(500).json({ error: 'O sistema não está conectado ao GitHub. Contate o administrador.' });
    }
    if (!checkRepoAccess(req, owner, repo)) return res.status(403).json({ error: 'Acesso negado a este repositório' });

    try {
      const url = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath || ''}${ref ? `?ref=${ref}` : ''}`;
      const response = await axios.get(url, {
        headers: { 
          Authorization: `Bearer ${token}`,
          'User-Agent': 'AI-Site-Editor'
        }
      });
      res.json(response.data);
    } catch (error: any) {
      res.status(error.response?.status || 500).json(error.response?.data || { error: 'Erro ao buscar conteúdo' });
    }
  });

  app.get('/api/github/history', verifyFirebaseToken, async (req: any, res: any) => {
    const token = await getGithubToken(req);
    const { owner, repo, path: filePath } = req.query;
    if (!token) {
      if (req.userData.role === 'admin') return res.status(401).json({ error: 'Não autenticado no GitHub' });
      return res.status(500).json({ error: 'O sistema não está conectado ao GitHub. Contate o administrador.' });
    }
    if (!checkRepoAccess(req, owner, repo)) return res.status(403).json({ error: 'Acesso negado a este repositório' });

    try {
      const response = await axios.get(`https://api.github.com/repos/${owner}/${repo}/commits?path=${filePath || ''}`, {
        headers: { 
          Authorization: `Bearer ${token}`,
          'User-Agent': 'AI-Site-Editor'
        }
      });
      res.json(response.data);
    } catch (error: any) {
      res.status(error.response?.status || 500).json(error.response?.data || { error: 'Erro ao buscar histórico' });
    }
  });

  app.post('/api/github/commit', verifyFirebaseToken, async (req: any, res: any) => {
    const token = await getGithubToken(req);
    const { owner, repo, path: filePath, content, message, sha } = req.body;
    if (!token) {
      if (req.userData.role === 'admin') return res.status(401).json({ error: 'Não autenticado no GitHub' });
      return res.status(500).json({ error: 'O sistema não está conectado ao GitHub. Contate o administrador.' });
    }
    if (!checkRepoAccess(req, owner, repo)) return res.status(403).json({ error: 'Acesso negado a este repositório' });

    try {
      const response = await axios.put(`https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`, {
        message,
        content: Buffer.from(content).toString('base64'),
        sha
      }, {
        headers: { 
          Authorization: `Bearer ${token}`,
          'User-Agent': 'AI-Site-Editor'
        }
      });
      res.json(response.data);
    } catch (error: any) {
      res.status(error.response?.status || 500).json(error.response?.data || { error: 'Erro ao realizar commit' });
    }
  });

  app.post('/api/gemini/generate', async (req, res) => {
    try {
      const { prompt } = req.body;
      if (!prompt) {
        return res.status(400).json({ error: 'Prompt is required' });
      }

      const { GoogleGenAI } = await import("@google/genai");
      // Usa a chave customizada se existir, senão tenta a padrão
      const apiKey = process.env.CUSTOM_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
      const ai = new GoogleGenAI({ apiKey });
      
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: prompt,
      });

      res.json({ text: response.text });
    } catch (error: any) {
      console.error('Gemini API Error:', error);
      res.status(500).json({ error: error.message || 'Erro ao gerar conteúdo' });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production' && process.env.VERCEL !== '1') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (req, res) => {
        if (req.path.startsWith('/api')) return res.status(404).json({ error: 'API route not found' });
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }
  }

  // Only listen if not running as a Vercel function
  if (process.env.VERCEL !== '1') {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  }
  
  return app;
}

const appPromise = startServer();

// Export for Vercel
export default async (req: any, res: any) => {
  const app = await appPromise;
  return app(req, res);
};
