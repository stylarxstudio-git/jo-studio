require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const cron    = require('node-cron');
const axios   = require('axios');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Uploads folder ────────────────────────────────────────────────────────────
const UPLOADS = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS);

const storage = multer.diskStorage({
  destination: UPLOADS,
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

// ── JSON Database (no Python / compiling needed) ──────────────────────────────
const DB_PATH = path.join(__dirname, 'db', 'data.json');
if (!fs.existsSync(path.join(__dirname, 'db'))) fs.mkdirSync(path.join(__dirname, 'db'));

function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch { return { posts: [], hashtags: [], logs: [], _id: { posts: 1, hashtags: 1, logs: 1 } }; }
}
function writeDB(data) { fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2)); }

function insert(table, row) {
  const db = readDB();
  const id = db._id[table] || 1;
  const newRow = { ...row, id, created_at: new Date().toISOString() };
  db[table].push(newRow);
  db._id[table] = id + 1;
  writeDB(db);
  return newRow;
}
function update(table, id, patch) {
  const db = readDB();
  db[table] = db[table].map(r => r.id === id ? { ...r, ...patch } : r);
  writeDB(db);
}
function remove(table, id) {
  const db = readDB();
  db[table] = db[table].filter(r => r.id !== id);
  writeDB(db);
}
function getAll(table) { return readDB()[table] || []; }
function getOne(table, id) { return getAll(table).find(r => r.id === id); }

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS));

// ── Accounts helper ───────────────────────────────────────────────────────────
function accounts() {
  return [
    { id: 'ig1',  name: process.env.IG_1_NAME    || 'Instagram 1', token: process.env.IG_1_ACCESS_TOKEN,    businessId: process.env.IG_1_BUSINESS_ID },
    { id: 'ig2',  name: process.env.IG_2_NAME    || 'Instagram 2', token: process.env.IG_2_ACCESS_TOKEN,    businessId: process.env.IG_2_BUSINESS_ID },
    { id: 'tt',   name: 'TikTok',                                  token: process.env.TIKTOK_ACCESS_TOKEN,  openId:     process.env.TIKTOK_OPEN_ID   },
    { id: 'tw',   name: 'X / Twitter',                             apiKey: process.env.TW_API_KEY,          apiSecret:  process.env.TW_API_SECRET, accessToken: process.env.TW_ACCESS_TOKEN, accessSecret: process.env.TW_ACCESS_SECRET },
  ];
}

// ── Instagram posting ─────────────────────────────────────────────────────────
async function postIG(acc, mediaUrl, caption, isStory, isVideo) {
  try {
    const base = 'https://graph.facebook.com/v19.0';
    const p = { access_token: acc.token };
    if (isStory) {
      p.media_type = isVideo ? 'VIDEO' : 'IMAGE';
      p[isVideo ? 'video_url' : 'image_url'] = mediaUrl;
    } else {
      p.caption = caption;
      if (isVideo) { p.media_type = 'REELS'; p.video_url = mediaUrl; }
      else p.image_url = mediaUrl;
    }
    const container = await axios.post(`${base}/${acc.businessId}/media`, p);
    const cid = container.data.id;

    if (isVideo) {
      for (let i = 0; i < 24; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const s = await axios.get(`${base}/${cid}`, { params: { fields: 'status_code', access_token: acc.token } });
        if (s.data.status_code === 'FINISHED') break;
        if (s.data.status_code === 'ERROR') throw new Error('Video processing error');
      }
    }
    const pub = await axios.post(`${base}/${acc.businessId}/media_publish`, { creation_id: cid, access_token: acc.token });
    return { success: true, id: pub.data.id };
  } catch (e) { return { success: false, error: e.response?.data?.error?.message || e.message }; }
}

// ── TikTok posting ────────────────────────────────────────────────────────────
async function postTT(acc, mediaUrl, caption, isVideo) {
  try {
    const headers = { Authorization: `Bearer ${acc.token}`, 'Content-Type': 'application/json; charset=UTF-8' };
    const endpoint = isVideo
      ? 'https://open.tiktokapis.com/v2/post/publish/video/init/'
      : 'https://open.tiktokapis.com/v2/post/publish/content/init/';
    const body = isVideo
      ? { post_info: { title: caption, privacy_level: 'PUBLIC_TO_EVERYONE', disable_duet: false, disable_stitch: false, disable_comment: false }, source_info: { source: 'PULL_FROM_URL', video_url: mediaUrl } }
      : { post_info: { title: caption, privacy_level: 'PUBLIC_TO_EVERYONE', disable_comment: false }, source_info: { source: 'PULL_FROM_URL', photo_cover_index: 1, photo_images: [mediaUrl] }, post_mode: 'DIRECT_POST', media_type: 'PHOTO' };
    const r = await axios.post(endpoint, body, { headers });
    return { success: true, id: r.data.data?.publish_id };
  } catch (e) { return { success: false, error: e.response?.data?.error?.message || e.message }; }
}

// ── Twitter/X posting ─────────────────────────────────────────────────────────
async function postTW(acc, caption) {
  try {
    // Basic OAuth 1.0a tweet
    const OAuth = require('oauth-1.0a');
    const crypto = require('crypto');
    const oauth = OAuth({ consumer: { key: acc.apiKey, secret: acc.apiSecret }, signature_method: 'HMAC-SHA1', hash_function(base, key) { return crypto.createHmac('sha1', key).update(base).digest('base64'); } });
    const url = 'https://api.twitter.com/2/tweets';
    const token = { key: acc.accessToken, secret: acc.accessSecret };
    const headers = oauth.toHeader(oauth.authorize({ url, method: 'POST' }, token));
    const r = await axios.post(url, { text: caption }, { headers: { ...headers, 'Content-Type': 'application/json' } });
    return { success: true, id: r.data.data?.id };
  } catch (e) { return { success: false, error: e.response?.data?.detail || e.message }; }
}

// ── Publish a post ────────────────────────────────────────────────────────────
async function publishPost(post) {
  const platforms = JSON.parse(post.platforms || '[]');
  const fullCaption = post.hashtags ? `${post.caption}\n\n${post.hashtags}` : post.caption;
  const mediaUrl = `http://localhost:${PORT}/uploads/${path.basename(post.media_path)}`;
  const isVideo = post.media_type === 'VIDEO';
  const isStory = post.is_story === 1;
  const accs = accounts();
  const results = [];

  for (const pid of platforms) {
    let result;
    if (pid === 'ig1') result = await postIG(accs.find(a => a.id === 'ig1'), mediaUrl, fullCaption, isStory, isVideo);
    else if (pid === 'ig2') result = await postIG(accs.find(a => a.id === 'ig2'), mediaUrl, fullCaption, isStory, isVideo);
    else if (pid === 'tiktok') result = await postTT(accs.find(a => a.id === 'tt'), mediaUrl, fullCaption, isVideo);
    else if (pid === 'twitter') result = await postTW(accs.find(a => a.id === 'tw'), fullCaption);

    if (result) {
      results.push({ platform: pid, ...result });
      insert('logs', { post_id: post.id, platform: pid, status: result.success ? 'success' : 'failed', response: JSON.stringify(result), logged_at: new Date().toISOString() });
    }
  }

  const ok = results.every(r => r.success);
  update('posts', post.id, { status: ok ? 'published' : 'failed' });
  return { results, status: ok ? 'published' : 'partial' };
}

// ── API: Upload ───────────────────────────────────────────────────────────────
app.post('/api/upload', upload.single('media'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ path: req.file.path, url: `http://localhost:${PORT}/uploads/${req.file.filename}`, mimetype: req.file.mimetype });
});

// ── API: Posts ────────────────────────────────────────────────────────────────
app.get('/api/posts', (req, res) => {
  const posts = getAll('posts').sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at));
  res.json(posts.map(p => ({ ...p, platforms: JSON.parse(p.platforms || '[]') })));
});
app.post('/api/posts', (req, res) => {
  const { caption, hashtags, media_path, media_type, platforms, scheduled_at, is_story, collab_handle } = req.body;
  const p = insert('posts', { caption, hashtags, media_path, media_type: media_type || 'IMAGE', platforms: JSON.stringify(platforms), scheduled_at, is_story: is_story || 0, collab_handle: collab_handle || '', status: 'pending' });
  res.json({ id: p.id });
});
app.delete('/api/posts/:id', (req, res) => { remove('posts', +req.params.id); res.json({ ok: true }); });
app.post('/api/posts/:id/publish-now', async (req, res) => {
  const post = getOne('posts', +req.params.id);
  if (!post) return res.status(404).json({ error: 'Not found' });
  res.json(await publishPost(post));
});

// ── API: Hashtags ─────────────────────────────────────────────────────────────
app.get('/api/hashtags', (req, res) => res.json(getAll('hashtags').sort((a, b) => b.used_count - a.used_count)));
app.post('/api/hashtags', (req, res) => res.json(insert('hashtags', { name: req.body.name, tags: req.body.tags, used_count: 0 })));
app.delete('/api/hashtags/:id', (req, res) => { remove('hashtags', +req.params.id); res.json({ ok: true }); });
app.post('/api/hashtags/:id/use', (req, res) => {
  const g = getOne('hashtags', +req.params.id);
  update('hashtags', +req.params.id, { used_count: (g?.used_count || 0) + 1 });
  res.json({ ok: true });
});

// ── API: AI (Ollama) ──────────────────────────────────────────────────────────
app.post('/api/ai/generate', async (req, res) => {
  const { prompt, type, context } = req.body;
  const OLLAMA = process.env.OLLAMA_URL || 'http://localhost:11434';
  const MODEL  = process.env.OLLAMA_MODEL || 'llama3';

  const systemMap = {
    caption:  'You are a social media expert. Write ONE engaging caption only. No explanations, no hashtags, just the caption text.',
    hashtags: 'You are a hashtag expert. Return ONLY hashtags separated by spaces starting with #. No text, no numbers, just hashtags.',
    both:     'You are a social media expert. Return ONLY valid JSON: {"caption":"...","hashtags":"#tag1 #tag2"}. Nothing else.'
  };
  const userPrompt = `${systemMap[type]}\n\nPost description: ${prompt}\nTone: ${context?.tone || 'authentic'}\nPlatform: ${context?.platform || 'Instagram'}`;

  try {
    const r = await axios.post(`${OLLAMA}/api/generate`, { model: MODEL, prompt: userPrompt, stream: false });
    res.json({ result: r.data.response });
  } catch {
    res.status(500).json({ error: 'Ollama is not running. Open a new PowerShell and type: ollama serve' });
  }
});

app.get('/api/ai/status', async (req, res) => {
  try { await axios.get(`${process.env.OLLAMA_URL || 'http://localhost:11434'}/api/tags`, { timeout: 2000 }); res.json({ online: true }); }
  catch { res.json({ online: false }); }
});

// ── API: Accounts ─────────────────────────────────────────────────────────────
app.get('/api/accounts', (req, res) => {
  res.json(accounts().map(a => ({ id: a.id, name: a.name, configured: !!(a.token || a.apiKey) && (a.token !== 'your_token_here') })));
});

// ── API: Logs ─────────────────────────────────────────────────────────────────
app.get('/api/logs', (req, res) => res.json(getAll('logs').sort((a, b) => new Date(b.logged_at) - new Date(a.logged_at)).slice(0, 100)));

// ── Scheduler: runs every minute ──────────────────────────────────────────────
cron.schedule('* * * * *', async () => {
  const now  = new Date().toISOString().slice(0, 16);
  const due  = getAll('posts').filter(p => p.status === 'pending' && p.scheduled_at <= now);
  for (const p of due) {
    console.log(`📤 Auto-publishing post #${p.id}`);
    await publishPost(p);
  }
});

app.listen(PORT, () => {
  console.log(`\n✅  Jo's Studio is running!`);
  console.log(`👉  Open this in your browser: http://localhost:${PORT}\n`);
});
