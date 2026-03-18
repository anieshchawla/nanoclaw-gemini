import fs from 'fs';
import path from 'path';
import { GoogleGenerativeAI, Part, Content } from '@google/generative-ai';
import { execSync, spawn, ChildProcess } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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

const nativeTools = [
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
  }
];

const mcpClients: Record<string, Client> = {};
const toolToClient: Record<string, Client> = {};

async function setupMcpServers(containerInput: ContainerInput, sdkEnv: Record<string, string | undefined>) {
  // Pass chat context to MCP servers via environment
  const mcpEnv = {
    ...sdkEnv,
    NANOCLAW_CHAT_JID: containerInput.chatJid,
    NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
    NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
  };

  const mcpServers = {
    nanoclaw: {
      command: 'node',
      args: ['/tmp/dist/ipc-mcp-stdio.js']
    }
    // Ollama explicitly excluded per user request
  };

  const allTools: any[] = [...nativeTools];

  for (const [serverName, config] of Object.entries(mcpServers)) {
    try {
      const transport: StdioClientTransport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: mcpEnv as Record<string, string>
      });

      // Manually handle stderr from the transport process to surface logs
      // @ts-ignore - accessing private property for logging
      const cp: ChildProcess = (transport as any).process;
      if (cp && cp.stderr) {
        cp.stderr.on('data', (data: Buffer) => {
          const lines = data.toString().trim().split('\n');
          for (const line of lines) {
            if (line) console.error(line);
          }
        });
      }

      const client = new Client({ name: "nanoclaw-client", version: "1.0.0" }, { capabilities: {} });
      await client.connect(transport);
      mcpClients[serverName] = client;

      const toolsList = await client.listTools();
      for (const t of toolsList.tools) {
        toolToClient[t.name] = client;

        const properties: any = {};
        const required: string[] = [];
        
        if (t.inputSchema && t.inputSchema.properties) {
          for (const [propName, propDef] of Object.entries(t.inputSchema.properties as Record<string, any>)) {
            properties[propName] = {
              type: propDef.type || 'string',
              description: propDef.description || ''
            };
          }
        }
        if (t.inputSchema && t.inputSchema.required) {
          required.push(...(t.inputSchema.required as string[]));
        }

        const newTool = {
          name: t.name,
          description: t.description || '',
          parameters: {
            type: "object",
            properties,
            required
          }
        };

        const existingIdx = allTools.findIndex(x => x.name === t.name);
        if (existingIdx >= 0) {
          allTools[existingIdx] = newTool;
        } else {
          allTools.push(newTool);
        }
      }
      log(`Registered MCP server: ${serverName} with tools: ${toolsList.tools.map(t => t.name).join(', ')}`);
    } catch (err) {
      log(`Failed to start MCP server ${serverName}: ${err}`);
    }
  }

  return [{ functionDeclarations: allTools }];
}

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
  
  const client = toolToClient[name];
  if (client) {
    try {
      log(`Routing tool ${name} to MCP client`);
      const result = await client.callTool({ name, arguments: args });
      if (result && Array.isArray(result.content)) {
        const textContent = result.content.find((c: any) => c.type === 'text');
        if (textContent) {
          return { result: textContent.text };
        }
      }
      return result;
    } catch (err: any) {
      log(`MCP Tool Error (${name}): ${err.message || String(err)}`);
      return { error: err.message || String(err) };
    }
  }

  throw new Error(`Unknown tool: ${name}`);
}

async function runQuery(
  prompt: string,
  history: Content[],
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  tools: any
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

  try {
    const tools = await setupMcpServers(containerInput, sdkEnv);
    let history: Content[] = [];
    let prompt = containerInput.prompt;
    let closed = false;

    // Clear input dir on startup
    if (fs.existsSync(IPC_INPUT_DIR)) {
      for (const f of fs.readdirSync(IPC_INPUT_DIR)) {
        if (f.endsWith('.json') || f === '_close') {
          try { fs.unlinkSync(path.join(IPC_INPUT_DIR, f)); } catch {}
        }
      }
    }

    if (containerInput.groupFolder === 'whatsapp_testing_goog') {
      while (!closed) {
        const result = await runQuery(prompt, history, containerInput, sdkEnv, tools);
        history = result.history;
        
        if (result.closedDuringQuery) break;

        log('Query complete. Polling for next input (Testing Goog channel)...');
        let nextInput: string | null = null;
        while (!nextInput && !closed) {
          if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
            log('Received close sentinel.');
            closed = true;
            break;
          }

          const files = fs.existsSync(IPC_INPUT_DIR) ? fs.readdirSync(IPC_INPUT_DIR).filter(f => f.endsWith('.json')) : [];
          if (files.length > 0) {
            files.sort(); // Process oldest first
            const file = files[0];
            const filePath = path.join(IPC_INPUT_DIR, file);
            try {
              const data = fs.readFileSync(filePath, 'utf-8');
              const msg = JSON.parse(data);
              if (msg.type === 'message') {
                nextInput = msg.text;
                log(`Received next input from ${file}`);
              }
              fs.unlinkSync(filePath); // Delete file after processing
            } catch (err) {
              log(`Error reading IPC file ${file}: ${err}`);
              try { fs.unlinkSync(filePath); } catch {}
            }
          } else {
            await new Promise(resolve => setTimeout(resolve, IPC_POLL_MS));
          }
        }
        
        if (nextInput) {
          prompt = nextInput;
        }
      }
    } else {
      await runQuery(prompt, history, containerInput, sdkEnv, tools);
    }

    // Close MCP clients to allow process to exit
    for (const client of Object.values(mcpClients)) {
      try {
        await client.close();
      } catch (err) {
        log(`Error closing MCP client: ${err}`);
      }
    }
    
    process.exit(0);
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
