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

const doc = {
  fields: {
    allowedRepos: {
      arrayValue: {
        values: [
          { stringValue: "owner/repo" }
        ]
      }
    }
  }
};

console.log(parseFirestoreDocument(doc));
