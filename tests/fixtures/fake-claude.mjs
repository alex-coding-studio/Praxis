import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const sessionId = option('--session-id') ?? option('--resume');
const resume = args.includes('--resume');
const mcp = JSON.parse(option('--mcp-config') ?? '{}').mcpServers?.praxis;
const logPath = process.env.FAKE_CLAUDE_LOG;
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
send({ type: 'system', subtype: 'init', session_id: sessionId });

let rpcId = 0;
async function rpc(method, params) {
  const response = await fetch(mcp.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...mcp.headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  if (!response.ok) throw new Error(`MCP ${method} failed: ${response.status}`);
  return (await response.json()).result;
}

async function callTool(name, toolArguments) {
  send({
    type: 'assistant',
    requestId: `req_${rpcId + 1}`,
    message: {
      id: `msg_${rpcId + 1}`,
      content: [{ type: 'tool_use', name: `mcp__praxis__${name}` }],
      usage: {
        input_tokens: 1,
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: 0,
        output_tokens: 1,
      },
    },
  });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  const listed = await rpc('tools/list', {});
  if (!listed.tools.some((tool) => tool.name === name))
    throw new Error(`tool ${name} not listed`);
  return rpc('tools/call', { name, arguments: toolArguments });
}

const finish = (result, extra = {}) =>
  send({
    type: 'result',
    subtype: 'success',
    result,
    session_id: sessionId,
    usage: {
      input_tokens: 10,
      cache_read_input_tokens: 4,
      cache_creation_input_tokens: 0,
      output_tokens: 3,
      output_tokens_details: { thinking_tokens: 1 },
    },
    ...extra,
  });

const scenario = process.env.FAKE_CLAUDE_SCENARIO ?? 'echo';
let turn = 0;

async function respond(prompt) {
  turn += 1;
  if (logPath)
    appendFileSync(
      logPath,
      `${JSON.stringify({ resume, sessionId, prompt, args, turn, pid: process.pid })}\n`,
    );
  if (turn > 1) return finish(`CONTINUED:${prompt.split('\n')[0]}`);
  if (scenario === 'dispatch') {
    const first = await callTool('dispatch_worker', {
      decision: { decision: 'dispatch' },
    });
    if (first.isError) throw new Error(first.content[0].text);
    const second = await callTool('dispatch_worker', { decision: {} });
    if (!second.isError) throw new Error('overlapping dispatch was accepted');
    return finish('SUSPENDED');
  }
  if (scenario === 'job') {
    const result = await callTool('run_job', {
      label: 'fixture',
      executable: process.execPath,
      arguments: ['-e', "setTimeout(()=>console.log('JOB_DONE'),60)"],
    });
    if (result.isError) throw new Error(result.content[0].text);
    return finish('JOB_STARTED');
  }
  if (scenario === 'jobslow') {
    const result = await callTool('run_job', {
      label: 'fixture',
      executable: process.execPath,
      arguments: ['-e', "setTimeout(()=>console.log('JOB_DONE'),20)"],
    });
    if (result.isError) throw new Error(result.content[0].text);
    await new Promise((r) => setTimeout(r, 400));
    return finish('JOB_STARTED_SLOW');
  }
  if (scenario === 'nojobs') {
    const result = await callTool('run_job', {
      label: 'x',
      executable: 'true',
      arguments: [],
    }).catch((error) => ({
      isError: true,
      content: [{ type: 'text', text: error.message }],
    }));
    return finish(result.isError ? 'REJECTED' : 'STARTED');
  }
  if (scenario === 'nofinish') {
    const result = await callTool('dispatch_worker', { decision: {} });
    if (result.isError) throw new Error(result.content[0].text);
    return setInterval(() => {}, 1000);
  }
  if (scenario === 'cap') {
    for (let attempt = 0; attempt < 60; attempt++) {
      const result = await callTool('dispatch_worker', { decision: {} });
      if (!result.isError) throw new Error('malformed dispatch was accepted');
    }
    return finish('CAP_NOT_REACHED');
  }
  if (scenario === 'usage') {
    // 同一个 API 响应拆成 thinking / text / tool_use 三条记录，共享 requestId 与 message.id
    for (const [index, usage] of [
      {
        input_tokens: 2,
        cache_read_input_tokens: 5000,
        cache_creation_input_tokens: 40,
        output_tokens: 1,
      },
      {
        input_tokens: 2,
        cache_read_input_tokens: 5000,
        cache_creation_input_tokens: 40,
        output_tokens: 7,
      },
      {
        input_tokens: 2,
        cache_read_input_tokens: 5000,
        cache_creation_input_tokens: 40,
        output_tokens: 9,
      },
    ].entries())
      send({
        type: 'assistant',
        requestId: 'req_fixture_one',
        message: {
          id: 'msg_fixture_one',
          content: [{ type: 'text', text: `part ${index}` }],
          usage,
        },
      });
    send({
      type: 'assistant',
      requestId: 'req_fixture_two',
      message: {
        id: 'msg_fixture_two',
        content: [{ type: 'text', text: 'second' }],
        usage: {
          input_tokens: 1,
          cache_read_input_tokens: 5090,
          cache_creation_input_tokens: 12,
          output_tokens: 4,
        },
      },
    });
    return finish('USAGE');
  }
  if (scenario === 'hang') return setInterval(() => {}, 1000);
  if (scenario === 'error')
    return send({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'boom',
      session_id: sessionId,
    });
  if (scenario === 'nooutput')
    return send({
      type: 'result',
      subtype: 'success',
      result: '',
      session_id: sessionId,
    });
  return finish(`ECHO:${prompt}`);
}

const queue = [];
let busy = false;
async function drain() {
  if (busy) return;
  busy = true;
  while (queue.length) await respond(queue.shift());
  busy = false;
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message?.type !== 'user') return;
  const content = message.message?.content;
  queue.push(typeof content === 'string' ? content : JSON.stringify(content));
  void drain();
});
