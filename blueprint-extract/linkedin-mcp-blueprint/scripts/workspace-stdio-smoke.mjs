/**
 * Phase 5 workspace smoke — run the REAL stdio MCP server as a live child
 * process and drive the actual protocol over stdin/stdout: initialize,
 * tools/list, tools/call (safe read tools), error behavior (unknown tool),
 * then clean shutdown.
 */
import { spawn } from 'node:child_process';

const PROTO = '2026-11-05';

function send(child, obj) {
  child.stdin?.write(`${JSON.stringify(obj)}\n`);
}

function main() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['dist/mcp/transport/stdio-entry.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ENVIRONMENT: 'local',
        OAUTH_PROVIDER: 'mock',
        // Self-hosted posture: NO billing env. This proves the stdio MCP
        // server runs with zero hosted dependency.
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdoutLines = [];
    const stderrLines = [];
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d) => {
      for (const line of d.split('\n')) {
        if (line.trim() !== '') stdoutLines.push(line);
      }
    });
    child.stderr?.on('data', (d) => {
      stderrLines.push(String(d));
    });

    const waitFor = (n, timeoutMs) =>
      new Promise((res, rej) => {
        const t0 = Date.now();
        const check = () => {
          if (stdoutLines.length >= n) {
            res(stdoutLines.slice(0, n));
            return;
          }
          if (Date.now() - t0 > timeoutMs) {
            rej(new Error(`timeout waiting for ${String(n)} responses; got ${String(stdoutLines.length)}: ${stdoutLines.join(' | ').slice(0, 300)}`));
            return;
          }
          setTimeout(check, 25);
        };
        check();
      });

    const jsonrpcLine = (raw) => JSON.parse(raw);

    const step = async () => {
      // 1. initialize
      send(child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTO, capabilities: {}, clientInfo: { name: 'workspace-smoke', version: '1.0' } } });
      const [initRaw] = await waitFor(1, 8000);
      const init = jsonrpcLine(initRaw);
      if (init.id !== 1 || init.result === undefined) throw new Error(`bad initialize response: ${initRaw.slice(0, 200)}`);
      const serverInfo = (init.result).serverInfo;
      console.log('1) initialize OK — server:', String(serverInfo.name), String(serverInfo.version), '| proto:', String(init.result.protocolVersion));
      send(child, { jsonrpc: '2.0', method: 'notifications/initialized' });

      // 2. tools/list
      send(child, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      const [, toolsRaw] = await waitFor(2, 8000);
      const tools = jsonrpcLine(toolsRaw).result;
      const names = tools.tools.map((t) => t.name);
      console.log(`2) tools/list OK — ${String(names.length)} tools:`, names.join(', '));
      if (!names.includes('linkedin_status') || !names.includes('linkedin_publish_post')) throw new Error('expected tools missing');

      // 3. safe tool call: status (read-only, works disconnected)
      send(child, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'status', arguments: {} } });
      const [, , statusRaw] = await waitFor(3, 8000);
      const statusResult = jsonrpcLine(statusRaw).result;
      const statusPayload = JSON.parse(statusResult.content[0]?.text ?? '{}');
      console.log('3) tools/call status OK — linkedin:', String(statusPayload.linkedin), '| env:', String(statusPayload.environment));
      if (statusResult.isError === true) throw new Error('status tool errored');

      // 4. linkedin_status tool (honest disconnected state)
      send(child, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'linkedin_status', arguments: {} } });
      const [, , , lsRaw] = await waitFor(4, 8000);
      const lsResult = jsonrpcLine(lsRaw).result;
      const lsPayload = JSON.parse(lsResult.content[0]?.text ?? '{}');
      console.log('4) linkedin_status OK — connected:', String(lsPayload.connected), '(honest disconnected state)');
      if (lsResult.isError === true) throw new Error('linkedin_status tool errored');

      // 5. error behavior: unknown tool
      send(child, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } });
      const lines = await waitFor(5, 8000);
      const errResp = jsonrpcLine(lines[4]);
      const isError = errResp.result?.isError === true || errResp.error !== undefined;
      console.log('5) unknown tool → structured error OK (isError/error present:', String(isError), ')');
      if (!isError) throw new Error('unknown tool did not produce an error result');

      // 6. shutdown
      child.kill('SIGTERM');
      const closed = await new Promise((res2) => {
        child.on('exit', () => { res2(true); });
        setTimeout(() => { res2(false); }, 5000);
      });
      console.log('6) shutdown OK — process exited:', String(closed));
      if (!closed) {
        child.kill('SIGKILL');
        throw new Error('server did not exit on SIGTERM');
      }
      resolve();
    };

    step().then(resolve).catch(reject);
    setTimeout(() => { reject(new Error('overall smoke timeout')); child.kill('SIGKILL'); }, 30_000);
  });
}

void main().then(
  () => { console.log('STDIO WORKSPACE SMOKE: PASS'); process.exit(0); },
  (err) => { console.error('STDIO WORKSPACE SMOKE: FAIL —', err instanceof Error ? err.message : String(err)); process.exit(1); },
);
