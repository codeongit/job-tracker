import { RemoteError } from './github.js';
import { serializeForSync } from './limits.js';
import { validateData } from './model.js';
export async function discoverLocalSsh(fetcher = fetch) {
  if (!['127.0.0.1', 'localhost'].includes(location.hostname)) return null;
  try {
    const r = await fetcher('./__local/session', { cache: 'no-store' });
    if (!r.ok) return null;
    const info = await r.json();
    return info.enabled && info.session && info.target ? info : null;
  } catch {
    return null;
  }
}
export function localSshClient(session, fetcher = fetch) {
  async function request(method, body) {
    let res;
    try {
      res = await fetcher('./__local/git', {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Job-Tracker-Session': session },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(180000),
      });
    } catch {
      throw new RemoteError('本机 SSH 服务暂时无法连接，本地修改已保留。', 0);
    }
    const result = await res.json();
    if (!res.ok) {
      const error = new RemoteError(
        result.message || 'SSH 同步失败。',
        res.status === 503 ? 0 : res.status,
      );
      error.code = result.code;
      throw error;
    }
    return result;
  }
  return {
    read: async () => {
      const r = await request('GET');
      return { ...r, data: validateData(r.data) };
    },
    write: (data, sha) => {
      serializeForSync(data);
      return request('PUT', { data: validateData(data), sha });
    },
  };
}
