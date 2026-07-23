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

// ─── BOOKING → GUESTS DB ──────────────────────────

app.post('/api/booking', async (req, res) => {
  const { name, phone } = req.body;

  if (!name || !phone) {
    return res.status(400).json({ error: 'name and phone required' });
  }

  try {
    // Ищем гостя по телефону
    const searchRes = await fetch(`https://api.notion.com/v1/databases/${NOTION_GUESTS_DB_ID}/query`, {
      method: 'POST',
      headers: NOTION_HEADERS,
      body: JSON.stringify({
        filter: { property: 'Телефон', phone_number: { equals: phone } }
      })
    });
    const searchData = await searchRes.json();
    const existing = searchData.results?.[0];

    if (existing) {
      // Обновляем счётчик броней
      const currentCount = existing.properties['Количество броней']?.number || 0;
      await fetch(`https://api.notion.com/v1/pages/${existing.id}`, {
        method: 'PATCH',
        headers: NOTION_HEADERS,
        body: JSON.stringify({
          properties: {
            'Количество броней': { number: currentCount + 1 }
          }
        })
      });
      return res.json({ status: 'updated', id: existing.id });
    }

    // Создаём новую запись
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

app.get('/', (req, res) => {
  res.send('Notion Proxy for На Крыше is running ✅');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
