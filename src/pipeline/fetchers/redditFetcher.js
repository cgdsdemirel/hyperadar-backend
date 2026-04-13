'use strict';

const axios  = require('axios');
const logger = require('../../utils/logger');

// ─── Subreddit & language maps ────────────────────────────────────────────────

const SUBREDDIT_MAP = {
  Global:   'all',
  Turkiye:  'Turkey',
  Almanya:  'de',
  Hindistan:'india',
  ABD:      'all',     // best-effort for US — r/all biased toward US content
};

const LANG_MAP = {
  Global:   'en',
  Turkiye:  'tr',
  Almanya:  'de',
  Hindistan:'hi',
  ABD:      'en',
};

const MAX_RESULTS    = 10;
const REDDIT_AUTH    = 'https://www.reddit.com/api/v1/access_token';
const REDDIT_API     = 'https://oauth.reddit.com';
const USER_AGENT     = 'HypeRadar/1.0 (pipeline bot; contact your-email@example.com)';

// ─── Mock fallback data ───────────────────────────────────────────────────────
// Used when Reddit API credentials are missing or the application is not yet
// approved. Keeps the 'reddit' category non-empty in the DB so queries return
// results while the real API is being set up.

const MOCK_TRENDS = {
  Global: [
    { title: 'AI-generated music is taking over indie playlists', description: 'Suno and Udio are flooding Spotify with AI tracks — listeners can\'t tell the difference' },
    { title: 'Micro-SaaS founders hitting $10k MRR in 90 days', description: 'A thread of solo founders sharing exact steps, niches, and revenue screenshots' },
    { title: 'Sleep optimization has become the new fitness trend', description: '8-hour sleep tracking, mouth taping, and HRV monitors dominate r/biohacking' },
    { title: 'Local LLMs are replacing cloud AI for privacy-focused users', description: 'Ollama and LM Studio hit 1M downloads; people running 70B models on M3 Macs' },
    { title: 'Walking 10k steps replaced by "zone 2 cardio" messaging', description: 'Fitness subreddits shifting from step counts to heart-rate zone training' },
  ],
  ABD: [
    { title: 'Remote work cafes replacing co-working spaces in US cities', description: 'Coffee shops with guaranteed desks, fast Wi-Fi, and no awkward 2-hour limits' },
    { title: 'US small businesses switching from Shopify to TikTok Shop', description: 'Conversion rates 3x higher on TikTok Shop for sub-$50 impulse products' },
    { title: 'Quiet luxury fashion trend driving minimalist brand startups', description: 'Founders launching capsule wardrobe brands with 10 SKUs and $1M+ revenue' },
    { title: 'Pet health insurance startups seeing explosive growth post-COVID', description: 'Americans spending record amounts on pets; insurtech niche still underserved' },
    { title: 'Digital nomad visa programs attracting US remote workers abroad', description: 'Portugal, Croatia, and Thailand leading; r/digitalnomad membership up 40%' },
  ],
  Turkiye: [
    { title: 'Türk yazılımcılar freelance platformlarında rekor kazanıyor', description: 'Upwork ve Toptal\'da Türk geliştiriciler dolar bazında maaş alıyor, yerel alternatifler artıyor' },
    { title: 'İstanbul\'da girişim ekosistemi hızla büyüyor', description: 'Yeni nesil Türk unicorn adayları: fintech, e-ticaret ve SaaS alanlarında yatırımlar artıyor' },
    { title: 'Türkçe içerik üreticileri YouTube\'da milyonlara ulaşıyor', description: 'Eğitim, teknoloji ve kişisel gelişim kanalları en hızlı büyüyen kategoriler arasında' },
    { title: 'Ev ofis kültürü Türkiye\'de kalıcı hale geliyor', description: 'Şirketler hibrit modele geçerken ergonomik mobilya ve ekipman satışları patladı' },
    { title: 'Türk e-ticaret pazarı küresel platformlara meydan okuyor', description: 'Trendyol ve Hepsiburada Orta Doğu ve Balkanlar\'a açılıyor' },
  ],
  Almanya: [
    { title: 'Deutsche Gründer setzen auf nachhaltige Geschäftsmodelle', description: 'Circular-Economy-Startups aus Deutschland gewinnen EU-Fördermittel und internationale Investoren' },
    { title: 'Homeoffice-Kultur verändert den deutschen Immobilienmarkt', description: 'Nachfrage nach Wohnungen mit separatem Arbeitszimmer in Mittelstädten steigt stark' },
    { title: 'KI-Tools revolutionieren den deutschen Mittelstand', description: 'Kleine und mittlere Unternehmen automatisieren Buchhaltung, Kundenservice und Logistik' },
    { title: 'E-Bikes überholen Autos als Hauptverkehrsmittel in deutschen Städten', description: 'Berlin, München und Hamburg melden Rekordverkäufe; Infrastrukturausbau hinkt hinterher' },
    { title: 'Deutschen Freelancer verdienen mehr als Angestellte', description: 'IT-Freiberufler in Deutschland erzielen durchschnittlich 120€/Stunde — Plattformen boomen' },
  ],
  Hindistan: [
    { title: 'भारतीय स्टार्टअप्स ग्लोबल मार्केट में छा रहे हैं', description: 'B2B SaaS कंपनियां अमेरिका और यूरोप में ग्राहक बना रही हैं, वैल्यूएशन रिकॉर्ड ऊंचाई पर' },
    { title: 'फ्रीलांसिंग भारत में नई नौकरी बन गई है', description: 'Upwork पर भारतीय फ्रीलांसर सबसे तेज़ बढ़ने वाला सेगमेंट; AI स्किल्स की मांग 5x' },
    { title: 'टियर-2 शहरों में टेक इकोसिस्टम उभर रहा है', description: 'पुणे, जयपुर, कोयम्बटूर में स्टार्टअप हब बन रहे हैं; किराया मुंबई से 60% कम' },
    { title: 'भारतीय कंटेंट क्रिएटर्स YouTube पर करोड़ों कमा रहे हैं', description: 'शॉर्ट-फॉर्म हिंदी कंटेंट का बूम; एजुकेशन और एंटरटेनमेंट चैनलों को सबसे ज़्यादा फायदा' },
    { title: 'UPI के बाद भारत का अगला फिनटेक इनोवेशन क्या है?', description: 'CBDC, क्रेडिट स्कोरिंग, और BNPL स्टार्टअप्स भारत के 500M+ बैंकिंग यूज़र्स को टारगेट कर रहे हैं' },
  ],
};

/**
 * Obtain a short-lived Reddit access token via OAuth2 client credentials.
 * @returns {Promise<string>} Bearer access token
 */
async function getRedditToken() {
  const credentials = Buffer.from(
    `${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`
  ).toString('base64');

  const { data } = await axios.post(
    REDDIT_AUTH,
    'grant_type=client_credentials',
    {
      timeout: 10_000,
      headers: {
        Authorization:  `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent':   USER_AGENT,
      },
    }
  );

  return data.access_token;
}

/**
 * Fetch the top hot posts from the appropriate subreddit for a HypeRadar region.
 *
 * @param {string} region - One of: Global | ABD | Turkiye | Almanya | Hindistan
 * @returns {Promise<Array<{ title, description, source, region, lang }>>}
 */
async function fetchRedditTrends(region) {
  try {
    const subreddit = SUBREDDIT_MAP[region] ?? 'all';
    const lang      = LANG_MAP[region]      ?? 'en';

    const token = await getRedditToken();

    const { data } = await axios.get(
      `${REDDIT_API}/r/${subreddit}/hot`,
      {
        timeout: 10_000,
        params:  { limit: MAX_RESULTS },
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent':  USER_AGENT,
        },
      }
    );

    const posts = data?.data?.children || [];

    return posts.map(({ data: post }) => ({
      title:       post.title    || '',
      description: post.selftext || post.url || '',
      source:      'reddit',
      region,
      lang,
    }));
  } catch (err) {
    logger.warn(`[RedditFetcher] API failed for region="${region}" (${err.message}) — using mock fallback`);

    const mocks = MOCK_TRENDS[region] || MOCK_TRENDS.Global;
    const lang  = LANG_MAP[region] ?? 'en';
    return mocks.map((m) => ({
      title:       m.title,
      description: m.description,
      source:      'reddit_mock',
      region,
      lang,
    }));
  }
}

module.exports = { fetchRedditTrends };
