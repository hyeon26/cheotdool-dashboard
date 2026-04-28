export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'POST') return res.status(405).end();

  const { nidAut, nidSes } = req.body || {};
  if(!nidAut || !nidSes) return res.status(400).json({ error: 'missing values' });

  const VERCEL_TOKEN = process.env.VERCEL_API_TOKEN;
  const PROJECT_ID = process.env.VERCEL_PROJECT_ID;

  if(!VERCEL_TOKEN || !PROJECT_ID) {
    return res.status(500).json({ error: 'VERCEL_API_TOKEN 또는 VERCEL_PROJECT_ID 미설정' });
  }

  try {
    // 기존 환경변수 목록 가져오기
    const listRes = await fetch(`https://api.vercel.com/v9/projects/${PROJECT_ID}/env`, {
      headers: { 'Authorization': `Bearer ${VERCEL_TOKEN}` }
    });
    const listData = await listRes.json();
    const envs = listData.envs || [];

    for(const [key, value] of [['CHZZK_NID_AUT', nidAut], ['CHZZK_NID_SES', nidSes]]) {
      const existing = envs.find(e => e.key === key);
      if(existing) {
        await fetch(`https://api.vercel.com/v9/projects/${PROJECT_ID}/env/${existing.id}`, {
          method: 'PATCH',
          headers: { 'Authorization': `Bearer ${VERCEL_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ value, target: ['production'] })
        });
      } else {
        await fetch(`https://api.vercel.com/v9/projects/${PROJECT_ID}/env`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${VERCEL_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, value, type: 'encrypted', target: ['production'] })
        });
      }
    }

    // 최신 배포 가져와서 Redeploy
    const deploysRes = await fetch(`https://api.vercel.com/v6/deployments?projectId=${PROJECT_ID}&limit=1`, {
      headers: { 'Authorization': `Bearer ${VERCEL_TOKEN}` }
    });
    const deploysData = await deploysRes.json();
    const latestDeploy = deploysData?.deployments?.[0];

    if(latestDeploy) {
      await fetch(`https://api.vercel.com/v13/deployments`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${VERCEL_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: latestDeploy.name,
          deploymentId: latestDeploy.uid,
          target: 'production',
        })
      });
    }

    res.status(200).json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
