import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Octokit } from '@octokit/rest';
import simpleGit, { SimpleGit } from 'simple-git';

// Configuration interface
interface Config {
    username: string;
    repoName: string;
    logFilePrefix: string;
}

const DEFAULT_CONFIG: Config = {
    username: '',
    repoName: 'contributions-recorder-logs',
    logFilePrefix: 'contributions-log'
};

let git: SimpleGit;
let octokit: Octokit | null = null;
let config: Config = DEFAULT_CONFIG;
let outputChannel: vscode.OutputChannel | undefined;

export async function activate(context: vscode.ExtensionContext) {
    try {
        // Create output channel if it doesn't exist
        if (!outputChannel) {
            outputChannel = vscode.window.createOutputChannel('Contributions Recorder');
        }
        
        // Force show the output channel
        outputChannel.show(true);
        
        // Add some initial logs to verify it's working
        log('===========================================');
        log('Contributions Recorder Extension Starting...');
        log(`Activation Time: ${new Date().toISOString()}`);
        
        // Command to show output channel
        let showOutputCommand = vscode.commands.registerCommand('contributions-recorder.showOutput', () => {
            if (outputChannel) {
                outputChannel.show(true);
            }
        });
        context.subscriptions.push(showOutputCommand);

        vscode.window.showInformationMessage('Contributions Recorder Extension Activated.');

        log('Starting extension activation...');

        // Check for workspace
        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspacePath) {
            throw new Error('No workspace folder found. Please open a folder with a Git repository.');
        }

        // Verify Git repository
        git = simpleGit(workspacePath);
        const isGitRepo = await git.checkIsRepo();
        if (!isGitRepo) {
            throw new Error('Current workspace is not a Git repository.');
        }
        log(`Git repository found at: ${workspacePath}`);

        // GitHub Authentication
        log('Checking GitHub authentication...');
        let authToken = context.globalState.get<string>('githubToken');
        
        if (!authToken) {
            log('No stored token found, requesting new token...');
            authToken = await authenticateWithGitHub();
            
            if (authToken) {
                await context.globalState.update('githubToken', authToken);
                log('Successfully stored new GitHub token');
            } else {
                throw new Error('Failed to obtain GitHub token');
            }
        }

        // Initialize Octokit
        log('Initializing GitHub API client...');
        octokit = new Octokit({ auth: authToken });

        // Verify GitHub authentication and get user info
        try {
            const { data: user } = await octokit.users.getAuthenticated();
            config.username = user.login;
            log(`Successfully authenticated as: ${config.username}`);
        } catch (error) {
            // If token is invalid, clear it and prompt for new one
            await context.globalState.update('githubToken', undefined);
            throw new Error('Invalid GitHub token. Please restart the extension to reauthenticate.');
        }

        // Ensure log repository exists
        log('Checking for logs repository...');
        await ensureGitHubRepo();
        log(`Repository ${config.repoName} is ready`);

        // Register commands
        const recordNowCommand = vscode.commands.registerCommand('contributions-recorder.recordNow', async () => {
            try {
                await logCommits(workspacePath);
                vscode.window.showInformationMessage('Manually triggered commit recording completed.');
            } catch (error) {
                handleError('Manual recording failed', error);
            }
        });
        context.subscriptions.push(recordNowCommand);

        // Set up automatic logging
        log('Setting up automatic commit logging...');
        const interval = setInterval(async () => {
            try {
                await logCommits(workspacePath);
            } catch (error) {
                handleError('Automatic recording failed', error);
            }
        }, 30 * 60 * 1000); // 30 minutes

        // Register cleanup
        context.subscriptions.push({
            dispose: () => {
                clearInterval(interval);
                log('Cleaned up logging interval');
            }
        });

        // Do initial log
        log('Performing initial commit recording...');
        await logCommits(workspacePath);

        vscode.window.showInformationMessage(
            'Contributions Recorder activated successfully! Recording every 30 minutes.'
        );
        log('Extension activation completed successfully');

    } catch (error) {
        const errorMessage = `Activation error: ${(error as Error).message}`;
        log(errorMessage);
        vscode.window.showErrorMessage(errorMessage);
        throw error; // Re-throw to mark extension activation as failed
    }
}

// Add these helper functions if not already present
function log(message: string) {
    const timestamp = new Date().toISOString();
    outputChannel.appendLine(`[${timestamp}] ${message}`);
}

function handleError(context: string, error: any) {
    const errorMessage = `${context}: ${error.message || 'Unknown error'}`;
    log(`ERROR - ${errorMessage}`);
    log(error.stack || 'No stack trace available');
    vscode.window.showErrorMessage(errorMessage);
}

async function authenticateWithGitHub(): Promise<string | undefined> {
    // For now, prompt for token (you should implement proper OAuth flow)
    const token = await vscode.window.showInputBox({
        prompt: 'Enter your GitHub Personal Access Token',
        password: true
    });
    return token;
}

async function ensureGitHubRepo(): Promise<void> {
    if (!octokit) {
		throw new Error('Octokit not initialized');
	}

    try {
        await octokit.repos.get({
            owner: config.username,
            repo: config.repoName
        });
    } catch (error: any) {
        if (error.status === 404) {
            await octokit.repos.createForAuthenticatedUser({
                name: config.repoName,
                private: true,
                auto_init: true
            });
            vscode.window.showInformationMessage(`Repository ${config.repoName} created.`);
        } else {
            throw error;
        }
    }
}

async function logCommits(workspacePath: string): Promise<void> {
    try {
        // Get the current date for the file name
        const now = new Date();
        const fileName = `${config.logFilePrefix}-${now.toISOString().split('T')[0]}.txt`;
        const logPath = path.join(workspacePath, fileName);

        // Try to get the last push date from the repository
        let lastPushDate: Date | null = null;
        if (octokit) {
            try {
                const { data: commits } = await octokit.repos.listCommits({
                    owner: config.username,
                    repo: config.repoName,
                    per_page: 1
                });
                
                if (commits.length > 0) {
                    lastPushDate = new Date(commits[0].commit.committer?.date || commits[0].commit.author?.date || '');
                }
            } catch (error) {
                // If repo is empty or other error, default to null
                lastPushDate = null;
            }
        }

        // Get commits since last push
        const logOptions: any = {
            "--since": lastPushDate ? lastPushDate.toISOString() : '1 day'
        };
        
        const log = await git.log(logOptions);

        // If no new commits, show message and return
        if (log.all.length === 0) {
            vscode.window.showInformationMessage('No new commits since last push.');
            return;
        }

        // Format commit data
        const logData = log.all
            .map(commit => `${commit.date} - ${commit.message} (${commit.author_name})`)
            .join('\n');

        // Add timestamp to the log
        const timestampedLogData = `[Log generated at ${now.toISOString()}]\n${logData}\n`;

        // Write to local file
        fs.writeFileSync(logPath, timestampedLogData);

        // Get the latest commit message for the push
        const latestCommitMessage = log.latest?.message || 'Update commit logs';

        // Push to GitHub
        await pushLogsToRepo(fileName, timestampedLogData, latestCommitMessage);
        vscode.window.showInformationMessage(`${log.all.length} new commits logged and pushed.`);
    } catch (error) {
        vscode.window.showErrorMessage(`Error logging commits: ${(error as Error).message}`);
    }
}

async function pushLogsToRepo(fileName: string, content: string, commitMessage:string): Promise<void> {
    if (!octokit) {
		throw new Error('Octokit not initialized');
	}

    const contentBase64 = Buffer.from(content).toString('base64');

    try {
        // Try to get existing file
        const { data: existingFile } = await octokit.repos.getContent({
            owner: config.username,
            repo: config.repoName,
            path: fileName
        }).catch(() => ({ data: null }));

        await octokit.repos.createOrUpdateFileContents({
            owner: config.username,
            repo: config.repoName,
            path: fileName,
            message: commitMessage,
            content: contentBase64,
            ...(existingFile && { sha: (existingFile as any).sha })
        });
    } catch (error) {
        throw new Error(`Failed to push logs: ${(error as Error).message}`);
    }
}

export function deactivate() {
    // Clean up resources if needed
}