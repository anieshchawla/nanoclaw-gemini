import fs from 'fs';
import path from 'path';
import { GoogleGenerativeAI, Part, Content } from '@google/generative-ai';
import { execSync } from 'child_process';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
  return filename;
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

const tools = [
  {
    functionDeclarations: [
      {
        name: "bash",
        description: "Run a bash command in the container. Use this for file operations, searching, or running the agent-browser tool. The current working directory is /workspace/group.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "The bash command to run" }
          },
          required: ["command"]
        }
      },
      {
        name: "send_message",
        description: "Send a message to the user immediately. Useful for progress updates during long tasks.",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "The message text to send" }
          },
          required: ["text"]
        }
      }
    ]
  }
];

async function handleFunctionCall(name: string, args: any, containerInput: ContainerInput): Promise<any> {
  log(`Executing tool: ${name} with args: ${JSON.stringify(args)}`);
  
  if (name === "bash") {
    try {
      const output = execSync(args.command, { encoding: 'utf8', cwd: '/workspace/group', stdio: 'pipe' });
      return { output };
    } catch (err: any) {
      return { error: err.stdout || err.stderr || err.message };
    }
  }
  
  if (name === "send_message") {
    writeIpcFile(MESSAGES_DIR, {
      type: 'message',
      chatJid: containerInput.chatJid,
      text: args.text,
      groupFolder: containerInput.groupFolder,
      timestamp: new Date().toISOString(),
    });
    return { status: "sent" };
  }

  throw new Error(`Unknown tool: ${name}`);
}

async function runQuery(
  prompt: string,
  history: Content[],
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
): Promise<{ history: Content[], closedDuringQuery: boolean }> {
  const apiKey = sdkEnv.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not found');

  const genAI = new GoogleGenerativeAI(apiKey);
  
  const globalGeminiMdPath = '/workspace/global/GEMINI.md';
  let systemInstruction = "You are Gemini, a helpful assistant.";
  if (fs.existsSync(globalGeminiMdPath)) {
    systemInstruction = fs.readFileSync(globalGeminiMdPath, 'utf-8');
  }

  const groupGeminiMdPath = '/workspace/group/GEMINI.md';
  if (fs.existsSync(groupGeminiMdPath)) {
    systemInstruction += "\n\n" + fs.readFileSync(groupGeminiMdPath, 'utf-8');
  }

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction: { role: 'system', parts: [{ text: systemInstruction }] },
    tools: tools as any,
  });

  let chat = model.startChat({ history });

  log(`Starting Gemini query...`);
  
  let result = await chat.sendMessage(prompt);
  let response = result.response;
  
  // Tool loop
  while (response.candidates?.[0]?.content?.parts?.some(p => p.functionCall)) {
    const parts = response.candidates[0].content.parts;
    const functionResponses: any[] = [];

    for (const part of parts) {
      if (part.functionCall) {
        const toolResult = await handleFunctionCall(part.functionCall.name, part.functionCall.args, containerInput);
        functionResponses.push({
          functionResponse: {
            name: part.functionCall.name,
            response: toolResult
          }
        });
      }
    }

    result = await chat.sendMessage(functionResponses);
    response = result.response;
  }

  const fullText = response.text();
  
  writeOutput({
    status: 'success',
    result: fullText,
    newSessionId: 'active-session'
  });

  return { history: await chat.getHistory(), closedDuringQuery: false };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(containerInput.secrets || {})) {
    sdkEnv[key] = value;
  }

  let history: Content[] = [];
  let prompt = containerInput.prompt;
  
  try {
    const queryResult = await runQuery(prompt, history, containerInput, sdkEnv);
    // For now we just run once and exit to avoid complexity with IPC wait in this version
    // NanoClaw will spawn a new container for the next message anyway
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      error: errorMessage
    });
    process.exit(1);
  }
}

main();
