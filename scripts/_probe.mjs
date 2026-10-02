const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' };
const LEAGUES = ['soccer/eng.1','soccer/esp.1','soccer/ita.1','soccer/ger.1','soccer/fra.1','soccer/eng.2','soccer/esp.2','soccer/ger.2','soccer/ned.1','soccer/por.1','soccer/bra.1','soccer/arg.1','soccer/usa.1','soccer/mex.1','soccer/uefa.champions','soccer/uefa.europa','basketball/nba','hockey/nhl'];
const now = Date.now();
const W0 = now + 6 * 3600e3, W1 = now + 48 * 3600e3;
const ymd = (d) => new Date(d).toISOString().slice(0, 10).replaceAll('-', '');
for (const key of LEAGUES) {
  try {
    const urls = [`${'https://site.api.espn.com/apis/site/v2/sports/'}${key}/scoreboard`];
    if (key.includes('nba') || key.includes('nhl')) {
      urls.push(`https://site.api.espn.com/apis/site/v2/sports/${key}/scoreboard?dates=${ymd(now + 3 * 3600e3)}`);
      urls.push(`https://site.api.espn.com/apis/site/v2/sports/${key}/scoreboard?dates=${ymd(now + 3 * 3600e3 + 86400e3)}`);
    }
    const evs = new Map();
    for (const u of urls) {
      const j = await (await fetch(u, { headers: UA })).json();
      for (const e of j.events ?? []) evs.set(String(e.id), e);
    }
    for (const e of evs.values()) {
      const t = new Date(e.date).getTime();
      if (t < W0 || t > W1) continue;
      const c = e.competitions?.[0]?.competitors ?? [];
      const rh = c.find(x => x.homeAway === 'home')?.records?.[0]?.summary;
      const ra = c.find(x => x.homeAway === 'away')?.records?.[0]?.summary;
      console.log(`IN-WINDOW ${key} | ${e.name} | ${e.date} | recH=${rh} recA=${ra}`);
    }
    if (!evs.size) console.log(`EMPTY ${key}`);
  } catch (err) { console.log(`SKIP ${key}: ${String(err).slice(0, 80)}`); }
}
