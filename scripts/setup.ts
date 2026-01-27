#!/usr/bin/env npx ts-node

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

const isTestMode = process.argv.includes('--test');

const testValues = {
  linearApiKey: 'lin_api_test123',
  githubToken: 'ghp_test456',
  pollingInterval: '30000',
  port: '3000',
  teamName: 'test-team',
  linearTeamId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  repoPath: '/tmp/test-repo',
  maxAgents: '2',
  githubRepo: 'test-org/test-repo',
  wantNotifications: false,
};

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(
  question: string,
  defaultValue?: string,
  testKey?: keyof typeof testValues
): Promise<string> {
  if (isTestMode && testKey) {
    const value = testValues[testKey] as string;
    console.log(`${question}: ${value} (test mode)`);
    return Promise.resolve(value);
  }
  const prompt = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

function askYesNo(
  question: string,
  defaultYes = true,
  testKey?: keyof typeof testValues
): Promise<boolean> {
  if (isTestMode && testKey) {
    const value = testValues[testKey] as boolean;
    console.log(`${question}: ${value ? 'yes' : 'no'} (test mode)`);
    return Promise.resolve(value);
  }
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  return new Promise((resolve) => {
    rl.question(`${question} ${hint}: `, (answer) => {
      const normalized = answer.trim().toLowerCase();
      if (normalized === '') {
        resolve(defaultYes);
      } else {
        resolve(normalized === 'y' || normalized === 'yes');
      }
    });
  });
}

async function setupEnv(): Promise<void> {
  const envPath = path.join(process.cwd(), '.env');
  const examplePath = path.join(process.cwd(), '.env.example');

  if (fs.existsSync(envPath) && !isTestMode) {
    const overwrite = await askYesNo('.env already exists. Overwrite?', false);
    if (!overwrite) {
      console.log('Skipping .env setup.\n');
      return;
    }
  }

  console.log('\n📋 Setting up .env file...\n');
  console.log('Get your Linear API key from: https://linear.app/settings/api\n');

  const linearApiKey = await ask('Linear API key', undefined, 'linearApiKey');
  const githubToken = await ask(
    'GitHub token (optional, for PR creation)',
    undefined,
    'githubToken'
  );
  const pollingInterval = await ask(
    'Polling interval in ms (0 for webhooks only)',
    '30000',
    'pollingInterval'
  );
  const port = await ask('Server port', '3000', 'port');

  let envContent = fs.readFileSync(examplePath, 'utf-8');
  envContent = envContent.replace('LINEAR_API_KEY=lin_api_xxxxx', `LINEAR_API_KEY=${linearApiKey}`);
  envContent = envContent.replace('GITHUB_TOKEN=ghp_xxxxx', `GITHUB_TOKEN=${githubToken}`);
  envContent = envContent.replace(
    'LINEAR_POLLING_INTERVAL_MS=0',
    `LINEAR_POLLING_INTERVAL_MS=${pollingInterval}`
  );
  envContent = envContent.replace('PORT=3000', `PORT=${port}`);

  fs.writeFileSync(envPath, envContent);
  console.log('✅ Created .env file\n');
}

async function setupTenants(): Promise<void> {
  const tenantsPath = path.join(process.cwd(), 'tenants.json');

  if (fs.existsSync(tenantsPath) && !isTestMode) {
    const overwrite = await askYesNo('tenants.json already exists. Overwrite?', false);
    if (!overwrite) {
      console.log('Skipping tenants.json setup.\n');
      return;
    }
  }

  console.log('\n📋 Setting up tenants.json...\n');
  console.log('To find your Linear team ID:');
  console.log('  1. Go to Linear and click on your team name');
  console.log('  2. Look at the URL: https://linear.app/YOUR-WORKSPACE/team/TEAM_ID/...');
  console.log('  3. The TEAM_ID is a UUID like "a1b2c3d4-e5f6-..."');
  console.log('  Or use the Linear API: https://studio.apollographql.com/public/Linear-API/\n');

  const name = await ask('Team name (for display)', 'my-team', 'teamName');
  const linearTeamId = await ask('Linear team ID (UUID)', undefined, 'linearTeamId');
  const repoPath = await ask('Absolute path to repository', undefined, 'repoPath');
  const maxAgents = await ask('Max concurrent agents', '2', 'maxAgents');
  const githubRepo = await ask('GitHub repo (org/repo format)', undefined, 'githubRepo');

  const wantNotifications = await askYesNo(
    '\nSet up Slack notifications?',
    false,
    'wantNotifications'
  );
  const notifications: Array<{ type: string; config: Record<string, string> }> = [];

  if (wantNotifications) {
    const webhookUrl = await ask('Slack webhook URL');
    if (webhookUrl) {
      notifications.push({
        type: 'slack',
        config: { webhookUrl },
      });
    }
  }

  const config = {
    tenants: [
      {
        name,
        linearTeamId,
        repoPath,
        maxConcurrentAgents: parseInt(maxAgents, 10),
        githubRepo,
        notifications,
      },
    ],
  };

  fs.writeFileSync(tenantsPath, JSON.stringify(config, null, 2) + '\n');
  console.log('✅ Created tenants.json\n');
}

async function checkPrerequisites(): Promise<void> {
  console.log('🔍 Checking prerequisites...\n');

  // Check for Claude CLI
  try {
    const { execSync } = await import('child_process');
    execSync('claude --version', { stdio: 'pipe' });
    console.log('✅ Claude Code CLI is installed');
  } catch {
    console.log('❌ Claude Code CLI not found');
    console.log('   Install: https://github.com/anthropics/claude-code\n');
  }

  // Check for GitHub CLI
  try {
    const { execSync } = await import('child_process');
    execSync('gh --version', { stdio: 'pipe' });
    console.log('✅ GitHub CLI is installed');
  } catch {
    console.log('❌ GitHub CLI not found');
    console.log('   Install: https://cli.github.com/\n');
  }

  console.log('');
}

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════');
  console.log('       Linear Autopilot Setup Wizard       ');
  console.log('═══════════════════════════════════════════\n');

  if (isTestMode) {
    console.log('🧪 Running in TEST MODE with dummy values\n');
  }

  await checkPrerequisites();
  await setupEnv();
  await setupTenants();

  console.log('═══════════════════════════════════════════');
  console.log('                 All done!                  ');
  console.log('═══════════════════════════════════════════\n');
  console.log('Next steps:');
  console.log('  1. Review .env and tenants.json');
  console.log('  2. Run: npm run dev');
  console.log('  3. Open: http://localhost:3000/dashboard');
  console.log('  4. Add the "agent-ready" label to a Linear ticket\n');

  rl.close();
}

main().catch((error) => {
  console.error('Setup failed:', error);
  rl.close();
  process.exit(1);
});
