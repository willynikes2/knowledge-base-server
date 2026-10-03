import { getDocument } from '../db.js';

export function read(args = []) {
  const json = args.includes('--json');
  const contentOnly = args.includes('--content-only');
  const ids = args.filter(arg => !arg.startsWith('--'));

  if (ids.length === 0) {
    console.error('Usage: kb read <id> [id...] [--json] [--content-only]');
    process.exit(1);
  }

  const docs = ids.map(id => {
    const parsed = Number.parseInt(id, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      console.error(`Invalid document id: ${id}`);
      process.exit(1);
    }
    return getDocument(parsed);
  });

  const missing = ids.filter((id, index) => !docs[index]);
  if (missing.length > 0) {
    console.error(`Document not found: ${missing.join(', ')}`);
    process.exit(1);
  }

  if (json) {
    console.log(JSON.stringify(docs.length === 1 ? docs[0] : docs, null, 2));
    return;
  }

  docs.forEach((doc, index) => {
    if (contentOnly) {
      if (index > 0) console.log('\n---\n');
      console.log(doc.content);
      return;
    }

    if (index > 0) console.log('\n---\n');
    console.log(`# ${doc.title}`);
    console.log('');
    console.log(`ID: ${doc.id}`);
    console.log(`Type: ${doc.doc_type}`);
    if (doc.tags) console.log(`Tags: ${doc.tags}`);
    if (doc.source) console.log(`Source: ${doc.source}`);
    if (doc.file_path) console.log(`File: ${doc.file_path}`);
    console.log(`Created: ${doc.created_at}`);
    console.log(`Updated: ${doc.updated_at}`);
    console.log('');
    console.log(doc.content);
  });
}
