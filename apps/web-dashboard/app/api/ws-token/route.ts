export async function POST() {
  const apiKey = process.env.GOAL_API_KEY;
  if (!apiKey) return Response.json({ error: 'GOAL_API_KEYが未設定です' }, { status: 500 });
  const response = await fetch('https://api.goal-api.com/v1/ws/token', { method:'POST',headers:{ Authorization:`Bearer ${apiKey}`,Accept:'application/json' } });
  const payload = await response.json();
  if (!response.ok) return Response.json({ error:`GOAL API HTTP ${response.status}` }, { status:response.status });
  const token = payload?.data?.token ?? payload?.token;
  if (!token) return Response.json({ error:'WebSocket tokenがありません' }, { status:502 });
  return Response.json({ token }, { headers:{'Cache-Control':'no-store'} });
}
