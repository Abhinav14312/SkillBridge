const { pbkdf2Sync, randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');

function askHidden(prompt) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    throw new Error('Run this command in an interactive terminal so the password can be entered privately.');
  }

  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdout.write('\n');
    };
    const onData = (key) => {
      if (key === '\u0003') {
        cleanup();
        reject(new Error('Cancelled.'));
      } else if (key === '\r' || key === '\n') {
        cleanup();
        resolve(value);
      } else if (key === '\u007f' || key === '\b') {
        value = value.slice(0, -1);
      } else if (!key.startsWith('\u001b')) {
        value += key;
      }
    };
    stdin.on('data', onData);
  });
}

function runWrangler(sql) {
  const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const tempDirectory = mkdtempSync(join(tmpdir(), 'skillbridge-password-reset-'));
  const sqlFile = join(tempDirectory, 'reset.sql');
  writeFileSync(sqlFile, sql, { encoding: 'utf8', mode: 0o600 });
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [
      '--yes', 'wrangler', 'd1', 'execute', 'skillbridge-db', '--remote', '--file', sqlFile, '--yes',
    ], { stdio: 'inherit', shell: process.platform === 'win32' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Wrangler exited with code ${code}.`)));
  }).finally(() => {
    rmSync(tempDirectory, { recursive: true, force: true });
  });
}

async function main() {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const email = (await rl.question('Account email: ')).trim().toLowerCase();
  rl.close();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid account email.');

  const password = await askHidden('New password (minimum 8 characters; input hidden): ');
  if (password.length < 8) throw new Error('Password must be at least 8 characters.');
  const confirmation = await askHidden('Confirm new password: ');
  if (password !== confirmation) throw new Error('The passwords do not match. No change was made.');

  const salt = randomBytes(16);
  const derived = pbkdf2Sync(password, salt, 100000, 32, 'sha256');
  const toBase64Url = (value) => value.toString('base64url');
  const passwordHash = `pbkdf2-sha256$100000$${toBase64Url(salt)}$${toBase64Url(derived)}`;
  const hashHex = Buffer.from(passwordHash, 'utf8').toString('hex');
  const emailHex = Buffer.from(email, 'utf8').toString('hex');
  const sql = `UPDATE users SET password_hash = CAST(X'${hashHex}' AS TEXT) WHERE email = CAST(X'${emailHex}' AS TEXT) RETURNING email;`;

  stdout.write('Updating the account password in the remote SkillBridge D1 database…\n');
  await runWrangler(sql);
  stdout.write('Wrangler completed the update command. Check its result above for the returned account email, then try signing in with the new password. If no row was returned, check the email and rerun.\n');
}

main().catch((error) => {
  stdout.write(`Password reset failed: ${error.message}\n`);
  process.exitCode = 1;
});
