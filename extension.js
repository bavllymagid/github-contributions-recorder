const simpleGit = require('simple-git');
const path = require('path');
const vscode = require('vscode');
const fs = require('fs');

const config = {
	username: '',
	repo: 'contributions-recorder-logs',
	logFilePrefix: 'contributions-log'
};
const activeEditor = vscode.window.activeTextEditor;
let git = null;
let octokit = null;
let outputChannel = null;

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {

	// Intializing the output channel
	console.log('Congratulations, your extension "github-contributions-recorder" is now active!');
	outputChannel = vscode.window.createOutputChannel('Github Contributions Recorder');
	outputChannel.show();
	outputChannel.appendLine('Github Contributions Recorder initialized!');


	try {
		let currentFolder = path.dirname(activeEditor.document.uri.fsPath);
		console.log(currentFolder);
		if (!currentFolder) {
			throw new Error('No workspace folder found. Please open a folder with a Git repository.');
		}

		git = simpleGit(currentFolder);
		const isRepo = git.checkIsRepo();
		if (!isRepo) {
			throw new Error('No Git repository found. Please open a folder with a Git repository.');
		}
		console.log(`Git repository found at: ${currentFolder}`);

		// Check if the user is authenticated with GitHub and get the token
		checkAuth(context).then((token) => {
			// Verify the authentication with GitHub
			verifyAuthentication(token).then(() => {
				console.log('GitHub authentication verified!');
				// Ensure the GitHub repository exists
				getOrCreateRepo().then(() => {
					console.log('Setting up automatic commit logging...');
					const interval = setInterval(async () => {
						try {
							await logCommits(currentFolder);
						} catch (error) {
							console.error(error);
						}
					}, 1000*60); // 1 second interval
					context.subscriptions.push({ dispose: () => clearInterval(interval) });
				}).catch((error) => {
					console.error(error);
				});
			}
			).catch((error) => {
				console.error(error);
			});
		}).catch((error) => {
			console.error(error);
		});


	} catch (error) {
		console.error(error);
	}

}

async function checkAuth(context) {
	console.log('Checking GitHub authentication...');
	let authToken = context.globalState.get('githubToken');
	if (!authToken) {
		let token = await authenticateWithGitHub();
		if (token) {
			await context.globalState.update('githubToken', token);
			console.log(`Successfully stored new GitHub token ${context.globalState.get('githubToken')}`);
			return token;
		}
	}
	return authToken;
}

async function verifyAuthentication(token) {
	// Initialize Octokit
	console.log('Initializing GitHub API client...');
	if (!octokit) {
		const { Octokit } = await import('@octokit/rest');
		octokit = new Octokit({ auth: token }); // Instantiate Octokit
	}

	// Verify the authentication
	console.log('Verifying GitHub authentication...');
	try {
		const { data } = await octokit.rest.users.getAuthenticated();
		config.username = data.login;
		console.log('GitHub authentication verified!');
		outputChannel.appendLine('GitHub authentication verified!');
		console.log(data);
	} catch (error) {
		console.error(error);
	}
}

async function authenticateWithGitHub() {
	console.log('Prompting user for GitHub token...');
	try {
		const token = await vscode.window.showInputBox({
			prompt: 'Enter your GitHub token',
			password: true,
			ignoreFocusOut: true,
		});
		if (token) {
			vscode.window.showInformationMessage(`You entered: ${token}`);
		} else {
			vscode.window.showWarningMessage('Input canceled or empty.');
		}
		return token;
	} catch (error) {
		vscode.window.showErrorMessage(`Error: ${error.message}`);
		return null;
	}
}

async function getOrCreateRepo() {
	console.log('Checking for logs repository...');
	console.log(`user name: ${config.username}, repo: ${config.repo}`);
	try {
		await octokit.repos.get({
			owner: config.username,
			repo: config.repo
		});
	} catch (error) {
		console.error(error);
		if (error.status === 404) {
			await octokit.repos.createForAuthenticatedUser({
				name: config.repo,
				private: true,
				auto_init: true
			});
			vscode.window.showInformationMessage(`Repository ${config.repo} created.`);
		} else {
			throw error;
		}
	}
}

async function logCommits(currentFolder) {
	try {
		// Get the current date for the file name
		const now = new Date();
		const fileName = `${config.logFilePrefix}-${now.toISOString().split('T')[0]}.txt`;
		const logPath = path.join(currentFolder, fileName);

		// Try to get the last push date from the repository
		let lastPushDate = null;
		if (octokit) {
			try {
				const { data } = await octokit.repos.listCommits({
					owner: config.username,
					repo: config.repo,
					per_page: 1
				});

				if (data.length > 0) {
					lastPushDate = new Date(data[0].commit.committer?.date || data[0].commit.author?.date || '');
				}
			} catch (error) {
				// If repo is empty or other error, default to null
				lastPushDate = null;
			}
		}

		// Get commits since last push
		const logOptions = {
			"--since": lastPushDate ? lastPushDate.toISOString() : '1 day'
		};

		git.log(logOptions).then(async (log) => {
			console.log(log);
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
			const timestamp = now.toISOString();
			const timestampedLogData = `[Log generated at ${timestamp}]\n${logData}\n`;


			// Write to local file
			fs.writeFileSync(logPath, timestampedLogData);

			// Get the latest commit message for the push
			const latestCommitMessage = log.latest?.message || 'Update commit logs';

			// Push to GitHub
			await pushLogsToRepo(fileName, timestampedLogData, latestCommitMessage);
			vscode.window.showInformationMessage(`${log.all.length} new commits logged and pushed.`);
		}).catch((error) => {
			throw new Error(`Error logging commits: ${(error).message}`);
		});

	} catch (error) {
		vscode.window.showErrorMessage(`Error logging commits: ${(error).message}`);
	}
}

async function pushLogsToRepo(fileName, content, commitMessage) {
	const contentBase64 = Buffer.from(content).toString('base64');

	try {
		// Try to get existing file
		const { data } = await octokit.repos.getContent({
			owner: config.username,
			repo: config.repo,
			path: fileName
		}).catch(() => ({ data: null }));

		let newContentBase64;

		if (data) {
			// If the file exists, get its current content (Base64 encoded)
			const existingContent = Buffer.from(data.content, 'base64').toString('utf-8');

			// Append the new content to the existing content
			const updatedContent = existingContent + '\n' + content;

			// Encode the updated content to Base64
			newContentBase64 = Buffer.from(updatedContent).toString('base64');
		} else {
			// If file doesn't exist, just use the new content as is
			newContentBase64 = contentBase64;
		}

		// Create or update the file
		await octokit.repos.createOrUpdateFileContents({
			owner: config.username,
			repo: config.repo,
			path: fileName,
			message: commitMessage,
			content: newContentBase64,
			...(data && { sha: data.sha })
		});

		console.log('Logs pushed successfully!');
	} catch (error) {
		throw new Error(`Failed to push logs: ${(error).message}`);
	}
}


// This method is called when your extension is deactivated
function deactivate() {
	console.log('Deactivated Github Contributions Recorder');
}

module.exports = {
	activate,
	deactivate
}
