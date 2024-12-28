const simpleGit = require('simple-git');
let Octokit;

(async () => {
  const { Octokit: octokit } = await import('@octokit/rest');
  Octokit = octokit;
  // Now you can use the Octokit class here
  console.log('Octokit imported successfully!');
})();

const vscode = require('vscode');

const config = {
	username: '',
	repo: 'contributions-recorder-logs',
	logFilePrefix: 'contributions-log'
};

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
		const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		console.log(workspacePath);
		if (!workspacePath) {
			throw new Error('No workspace folder found. Please open a folder with a Git repository.');
		}

		git = simpleGit(workspacePath);
		const isRepo = git.checkIsRepo();
		if (!isRepo) {
			throw new Error('No Git repository found. Please open a folder with a Git repository.');
		}
		console.log(`Git repository found at: ${workspacePath}`);

		// Check if the user is authenticated with GitHub and get the token
		let authToken = checkAuth(context).then((token) => {
			return token;
		}).catch((error) => {
			console.error(error);
		});
		// Verify the authentication with GitHub
		verifyAuthentication(authToken).then(() => {
			console.log('GitHub authentication verified!');
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
			await context.globalState.update('githubToken', authToken);
			console.log('Successfully stored new GitHub token');
			return token;
		}
	}
	return authToken;
}

async function verifyAuthentication(token) {
	// Initialize Octokit
	console.log('Initializing GitHub API client...');
	octokit = new Octokit({ auth: token });

	// Verify the authentication
	console.log('Verifying GitHub authentication...');
	try{
		const { data } = await octokit.rest.users.getAuthenticated();
		config.username = data.login;
		console.log('GitHub authentication verified!');
		outputChannel.appendLine('GitHub authentication verified!');
		console.log(data);
	}catch(error){
		console.error(error);
	}
}

async function authenticateWithGitHub() {
	const token = await vscode.window.showInputBox({
		prompt: 'Please enter your GitHub token',
		password: true,
	});
	if (!token) {
		throw new Error('No token provided. Please provide a valid GitHub token.');
	}
	return token;
}

// This method is called when your extension is deactivated
function deactivate() { }

module.exports = {
	activate,
	deactivate
}
