const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_EVENTS_DB_ID = '35173a71663680999ebcf882ecea022d';
const PORT = process.env.PORT || 3000;

app.get('/api/events', async (req, res) => {
  const today = new Date().toISOString().split('T')[0];

  try {
    const response = await fetch(`https://api.notion.com/v1/databases/${NOTION_EVENTS_DB_ID}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
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

app.get('/', (req, res) => {
  res.send('Notion Proxy for На Крыше is running ✅');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
