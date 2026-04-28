export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const aut = process.env.CHZZK_NID_AUT || '';
  const ses = process.env.CHZZK_NID_SES || '';
  res.status(200).json({ nidAut: aut, nidSes: ses });
}
