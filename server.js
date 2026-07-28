const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_EVENTS_DB_ID = '35173a71663680999ebcf882ecea022d';
const NOTION_GUESTS_DB_ID = 'f25cd3eb7e8441f2ada6bdd20700c4d6';
const PORT = process.env.PORT || 3000;

const NOTION_HEADERS = {
  'Authorization': `Bearer ${NOTION_TOKEN}`,
  'Notion-Version': '2022-06-28',
  'Content-Type': 'application/json'
};

// ─── EVENTS ───────────────────────────────────────

app.get('/api/events', async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  try {
    const response = await fetch(`https://api.notion.com/v1/databases/${NOTION_EVENTS_DB_ID}/query`, {
      method: 'POST',
      headers: NOTION_HEADERS,
      body: JSON.stringify({
        filter: { property: 'Дата', date: { on_or_after: today } },
        sorts: [{ property: 'Дата', direction: 'ascending' }]
      })
    });
    const data = await response.json();
    const events = (data.results || []).map(e => {
      const props = e.properties;
      return {
        name: props['Название']?.title?.[0]?.plain_text || '—',
        format: props['Формат']?.select?.name || '',
        date: props['Дата']?.date?.start || ''
      };
    });
    res.json(events);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

// ─── HELPERS ──────────────────────────────────────

async function findGuestByPhone(phone) {
  const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_GUESTS_DB_ID}/query`, {
    method: 'POST',
    headers: NOTION_HEADERS,
    body: JSON.stringify({
      filter: { property: 'Телефон', phone_number: { equals: phone } }
    })
  });
  const data = await res.json();
  return data.results?.[0] || null;
}

// ─── BOOKING → GUESTS DB ──────────────────────────

app.post('/api/booking', async (req, res) => {
  const { name, phone, date, time } = req.body;

  if (!name || !phone) {
    return res.status(400).json({ error: 'name and phone required' });
  }

  try {
    const existing = await findGuestByPhone(phone);
    const bookingEntry = date ? `${date}${time ? ' ' + time : ''}` : new Date().toISOString().split('T')[0];

    if (existing) {
      const currentCount = existing.properties['Количество броней']?.number || 0;
      const existingHistory = existing.properties['История броней']?.rich_text?.[0]?.plain_text || '';
      const newHistory = existingHistory ? `${existingHistory}, ${bookingEntry}` : bookingEntry;

      await fetch(`https://api.notion.com/v1/pages/${existing.id}`, {
        method: 'PATCH',
        headers: NOTION_HEADERS,
        body: JSON.stringify({
          properties: {
            'Количество броней': { number: currentCount + 1 },
            'История броней': { rich_text: [{ text: { content: newHistory.slice(0, 1900) } }] }
          }
        })
      });
      return res.json({ status: 'updated', id: existing.id });
    }

    const createRes = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: NOTION_HEADERS,
      body: JSON.stringify({
        parent: { database_id: NOTION_GUESTS_DB_ID },
        properties: {
          'Имя': { title: [{ text: { content: name } }] },
          'Телефон': { phone_number: phone },
          'Источник': { select: { name: 'Бронь' } },
          'Дата первого контакта': { date: { start: new Date().toISOString().split('T')[0] } },
          'Количество броней': { number: 1 },
          'История броней': { rich_text: [{ text: { content: bookingEntry } }] },
          'Перенесён в Карточку Гостя': { checkbox: false }
        }
      })
    });

    const createData = await createRes.json();
    res.json({ status: 'created', id: createData.id });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to save booking' });
  }
});

// ─── PROFILE → UPSERT BY PHONE ────────────────────

app.post('/api/profile', async (req, res) => {
  const { name, username, phone, birthday } = req.body;

  if (!phone) {
    return res.status(400).json({ error: 'phone required' });
  }

  try {
    const existing = await findGuestByPhone(phone);

    const properties = {};
    if (birthday) properties['Дата рождения'] = { date: { start: birthday } };
    if (username) properties['Telegram Username'] = { rich_text: [{ text: { content: username } }] };

    if (existing) {
      await fetch(`https://api.notion.com/v1/pages/${existing.id}`, {
        method: 'PATCH',
        headers: NOTION_HEADERS,
        body: JSON.stringify({ properties })
      });
      return res.json({ status: 'updated', id: existing.id });
    }

    properties['Имя'] = { title: [{ text: { content: name || 'Гость' } }] };
    properties['Телефон'] = { phone_number: phone };
    properties['Источник'] = { select: { name: 'Другое' } };
    properties['Дата первого контакта'] = { date: { start: new Date().toISOString().split('T')[0] } };
    properties['Количество броней'] = { number: 0 };

    const createRes = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: NOTION_HEADERS,
      body: JSON.stringify({
        parent: { database_id: NOTION_GUESTS_DB_ID },
        properties
      })
    });
    const createData = await createRes.json();
    res.json({ status: 'created', id: createData.id });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to save profile' });
  }
});

// ─── GET GUEST BY PHONE ───────────────────────────

app.get('/api/guest', async (req, res) => {
  const phone = req.query.phone;
  if (!phone) return res.status(400).json({ error: 'phone required' });

  try {
    const guest = await findGuestByPhone(phone);
    if (!guest) return res.json(null);

    const props = guest.properties;
    res.json({
      name: props['Имя']?.title?.[0]?.plain_text || '',
      phone: props['Телефон']?.phone_number || '',
      birthday: props['Дата рождения']?.date?.start || null,
      bookingsCount: props['Количество броней']?.number || 0,
      history: props['История броней']?.rich_text?.[0]?.plain_text || ''
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch guest' });
  }
});

app.get('/', (req, res) => {
  res.send('Notion Proxy for На Крыше is running ✅');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
