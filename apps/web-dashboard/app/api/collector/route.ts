export const dynamic = 'force-dynamic';
const COLLECTOR = process.env.GOAL_COLLECTOR_URL ?? 'http://127.0.0.1:4317';
export async function GET() { return proxy('/status'); }
export async function POST(request: Request) { return proxy('/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: await request.text() }); }
async function proxy(path: string, init?: RequestInit) { try { const response = await fetch(`${COLLECTOR}${path}`, init); return new Response(await response.text(), { status: response.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }); } catch { return Response.json({ error: 'Collector daemonへ接続できません。起動スクリプトからアプリを再起動してください。' }, { status: 503 }); } }
