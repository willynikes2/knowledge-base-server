// src/cli/auth-cli.js — manage accounts that can approve OAuth (MCP) clients
import { createInterface } from 'readline';

const USAGE = `Usage: kb auth add-user <email> [--name <name>] [--password-stdin]

Creates an account that can sign in and approve OAuth clients such as the
Claude web connector. Public sign-up is disabled, so this is the only way to
create one. Without --password-stdin you are prompted for the password.`;

function readFlag(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data.replace(/\r?\n$/, '');
}

function promptHidden(question) {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = text => {
      if (text.startsWith(question)) rl.output.write(question);
    };
    rl.question(question, answer => {
      rl.output.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

async function readPassword(args) {
  if (args.includes('--password-stdin')) return readStdin();
  if (!process.stdin.isTTY) throw new Error('No terminal to prompt on; pipe the password with --password-stdin');
  const password = await promptHidden('Password: ');
  if (password !== await promptHidden('Repeat password: ')) throw new Error('Passwords do not match');
  return password;
}

export async function authCmd(args) {
  const [subcommand, email] = args;
  if (subcommand !== 'add-user' || !email || email.startsWith('--')) {
    console.error(USAGE);
    process.exit(1);
  }

  try {
    const { migrateAuthSchema, addUser } = await import('../auth-oauth.js');
    await migrateAuthSchema();
    const password = await readPassword(args);
    const user = await addUser({ email, password, name: readFlag(args, '--name') });
    console.log(`Created ${user.email}. Sign in with it when an MCP client asks you to authorize.`);
    process.exit(0);
  } catch (err) {
    console.error(`kb auth add-user: ${err.message}`);
    process.exit(1);
  }
}
