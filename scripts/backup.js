const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const appDirectory = path.join(__dirname, '..');
const sourcePath = path.join(appDirectory, 'skillbridge.sqlite');
const backupDirectory = path.join(appDirectory, 'backups');

if (!fs.existsSync(sourcePath)) {
  console.error('No local SkillBridge database found. Start the app and create an account first.');
  process.exitCode = 1;
} else {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.join(backupDirectory, `skillbridge-${timestamp}.sqlite`);
  fs.mkdirSync(backupDirectory, { recursive: true });
  const database = new Database(sourcePath, { readonly: true, fileMustExist: true });
  database.backup(destination)
    .then(() => console.log(`Database backup saved to ${path.relative(appDirectory, destination)}`))
    .catch((error) => {
      console.error('Could not back up the SkillBridge database:', error.message);
      process.exitCode = 1;
    })
    .finally(() => database.close());
}
