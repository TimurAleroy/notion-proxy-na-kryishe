const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_EVENTS_DB_ID = '35173a71663680999ebcf882ecea022d';
const NOTION_GUESTS_DB_ID = 'f25cd3eb7e8441f2ada6bdd20700c4d6';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '188483198';
const WEBAPP_URL = 'https://timuraleroy.github.io/na-kryishe';
const PORT = process.env.PORT || 3000;

const NOTION_HEADERS = {
  'Authorization': `Bearer ${NOTION_TOKEN}`,
  'Notion-Version': '2022-06-28',
  'Content-Type': 'application/json'
};

// Временное хранилище данных о брони для кнопок в Telegram (id → детали)
const bookingsMap = new Map();

// Приводим номер к единому виду: только цифры, с ведущим +7
function normalizePhone(raw) {
  if (!raw) return '';
  let digits = raw.replace(/[^\d+]/g, '');
  digits = digits.replace(/^8/, '+7');
  if (digits.startsWith('7') && !digits.startsWith('+7')) digits = '+' + digits;
  if (!digits.startsWith('+')) digits = '+7' + digits.replace(/^\+?7?/, '');
  return digits;
}

// Каждая запись в "Истории броней" хранится как "ISO-дата|текст|тип" (плюс статус в конце).
// Тип нужен чтобы разные виды броней (стол/VIP/мероприятие) не мешали друг другу.
function stripSuffix(raw) {
  return raw.replace(' (подтверждено)', '').replace(' (отменено)', '');
}
function parseEntry(raw) {
  const clean = stripSuffix(raw);
  const parts = clean.split('|');
  if (parts.length >= 3) return { iso: parts[0], display: parts[1], kind: parts.slice(2).join('|') };
  if (parts.length === 2) return { iso: parts[0], display: parts[1], kind: 'table' };
  return { iso: null, display: parts[0], kind: 'table' };
}
function displayEntry(raw) {
  return parseEntry(raw).display;
}
function baseEntry(raw) {
  return stripSuffix(raw);
}
function isEntryExpired(iso) {
  if (!iso) return true; // старые записи без даты — считаем что бронь уже прошла
  const entryDate = iso.slice(0, 10);
  const todayDate = new Date().toISOString().slice(0, 10);
  return entryDate < todayDate;
}

async function tgApi(method, payload) {
  if (!TELEGRAM_BOT_TOKEN) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return await res.json();
  } catch (err) {
    console.error(`Telegram API ${method} failed:`, err);
    return null;
  }
}

async function sendTelegramMessage(chatId, text, replyMarkup) {
  if (!chatId) return null;
  const payload = { chat_id: chatId, text };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return tgApi('sendMessage', payload);
}

function formatBookingDetails({ name, phone, date, time, guests, comment, room, eventName }) {
  const roomLine = room ? `🔺 ${room}\n` : '';
  const eventLine = eventName ? `🎉 Мероприятие: ${eventName}\n` : '';
  return (
    roomLine +
    eventLine +
    `👤 Имя: ${name}\n` +
    `📱 Телефон: ${phone}\n` +
    `🗓 Дата: ${date || '—'}\n` +
    `⏰ Время: ${time || '—'}\n` +
    `👥 Гостей: ${guests || '—'}` +
    (comment ? `\n💬 Комментарий: ${comment}` : '')
  );
}

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
        date: props['Дата']?.date?.start || '',
        description: props['Описание']?.rich_text?.[0]?.plain_text || ''
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
  const normalized = normalizePhone(phone);
  const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_GUESTS_DB_ID}/query`, {
    method: 'POST',
    headers: NOTION_HEADERS,
    body: JSON.stringify({
      filter: { property: 'Телефон', phone_number: { equals: normalized } }
    })
  });
  const data = await res.json();
  return data.results?.[0] || null;
}

// Общая функция отмены брони — используется и из мини-аппа, и из кнопки в Telegram
async function cancelBookingInternal(phone, entry, customMessage) {
  const guest = await findGuestByPhone(phone);
  if (!guest) return { ok: false, error: 'guest not found' };

  const props = guest.properties;
  const historyText = props['История броней']?.rich_text?.[0]?.plain_text || '';
  const entries = historyText.split(',').map(s => s.trim());
  const updatedEntries = entries.map(e => e.replace(' (подтверждено)', '') === entry ? `${entry} (отменено)` : e);
  const newHistory = updatedEntries.join(', ');
  const currentCount = props['Количество броней']?.number || 0;

  await fetch(`https://api.notion.com/v1/pages/${guest.id}`, {
    method: 'PATCH',
    headers: NOTION_HEADERS,
    body: JSON.stringify({
      properties: {
        'История броней': { rich_text: [{ text: { content: newHistory.slice(0, 1900) } }] },
        'Количество броней': { number: Math.max(0, currentCount - 1) }
      }
    })
  });

  const guestName = props['Имя']?.title?.[0]?.plain_text || 'Гость';
  const telegramId = props['Telegram ID']?.rich_text?.[0]?.plain_text;

  if (telegramId) {
    const text = customMessage || `Бронирование отменено. Будем рады видеть вас в следующий раз.\n\n🗓 ${displayEntry(entry)}`;
    await sendTelegramMessage(telegramId, text);
  }

  return { ok: true, guestName, telegramId };
}

// Помечаем бронь как подтверждённую в истории (используется при нажатии "✅ Подтвердить")
async function confirmBookingInternal(phone, entry) {
  const guest = await findGuestByPhone(phone);
  if (!guest) return { ok: false };

  const props = guest.properties;
  const historyText = props['История броней']?.rich_text?.[0]?.plain_text || '';
  const entries = historyText.split(',').map(s => s.trim());
  const updatedEntries = entries.map(e => e === entry ? `${entry} (подтверждено)` : e);
  const newHistory = updatedEntries.join(', ');

  await fetch(`https://api.notion.com/v1/pages/${guest.id}`, {
    method: 'PATCH',
    headers: NOTION_HEADERS,
    body: JSON.stringify({
      properties: {
        'История броней': { rich_text: [{ text: { content: newHistory.slice(0, 1900) } }] }
      }
    })
  });

  return { ok: true };
}

// ─── BOOKING → GUESTS DB + УВЕДОМЛЕНИЯ ────────────

app.post('/api/booking', async (req, res) => {
  const { name, phone: rawPhone, date, dateISO, time, guests, comment, room, eventName, telegramId, telegramUsername } = req.body;
  const phone = normalizePhone(rawPhone);

  if (!name || !phone) {
    return res.status(400).json({ error: 'name and phone required' });
  }

  try {
    const existing = await findGuestByPhone(phone);

    let displayText = date ? `${date}${time ? ' ' + time : ''}` : new Date().toISOString().split('T')[0];
    if (room) displayText += ` · ${room}`;
    else if (eventName) displayText += ` · ${eventName}`;

    const kind = room ? 'vip' : (eventName ? `event:${eventName}` : 'table');

    const isoTime = time && /^\d{2}:\d{2}$/.test(time) ? time : '00:00';
    const isoDateTime = dateISO ? `${dateISO}T${isoTime}:00` : null;
    const bookingEntry = isoDateTime ? `${isoDateTime}|${displayText}|${kind}` : `${displayText}|${kind}`;

    const properties = {};
    if (telegramId) properties['Telegram ID'] = { rich_text: [{ text: { content: String(telegramId) } }] };
    if (telegramUsername) properties['Telegram Username'] = { rich_text: [{ text: { content: telegramUsername } }] };

    if (existing) {
      const currentCount = existing.properties['Количество броней']?.number || 0;
      const existingHistory = existing.properties['История броней']?.rich_text?.[0]?.plain_text || '';
      const newHistory = existingHistory ? `${existingHistory}, ${bookingEntry}` : bookingEntry;

      properties['Количество броней'] = { number: currentCount + 1 };
      properties['История броней'] = { rich_text: [{ text: { content: newHistory.slice(0, 1900) } }] };

      await fetch(`https://api.notion.com/v1/pages/${existing.id}`, {
        method: 'PATCH',
        headers: NOTION_HEADERS,
        body: JSON.stringify({ properties })
      });
    } else {
      properties['Имя'] = { title: [{ text: { content: name } }] };
      properties['Телефон'] = { phone_number: phone };
      properties['Источник'] = { select: { name: 'Бронь' } };
      properties['Дата первого контакта'] = { date: { start: new Date().toISOString().split('T')[0] } };
      properties['Количество броней'] = { number: 1 };
      properties['История броней'] = { rich_text: [{ text: { content: bookingEntry } }] };
      properties['Перенесён в Карточку Гостя'] = { checkbox: false };

      await fetch('https://api.notion.com/v1/pages', {
        method: 'POST',
        headers: NOTION_HEADERS,
        body: JSON.stringify({ parent: { database_id: NOTION_GUESTS_DB_ID }, properties })
      });
    }

    const details = formatBookingDetails({ name, phone, date, time, guests, comment, room, eventName });

    // Гостю — короткое подтверждение без его же личных данных
    if (telegramId) {
      const roomLine = room ? `🔺 ${room}\n` : '';
      const eventLine = eventName ? `🎉 ${eventName}\n` : '';
      const guestSummary = `${roomLine}${eventLine}🗓 ${date || '—'} в ${time || '—'}\n👥 Гостей: ${guests || '—'}`;
      await sendTelegramMessage(
        telegramId,
        `✅ Приняли бронь! Как только администратор подтвердит, мы свяжемся с вами.\n\n${guestSummary}`
      );
    }

    // Сохраняем детали для обработки нажатий кнопок
    const bookingId = crypto.randomUUID().slice(0, 8);
    bookingsMap.set(bookingId, { phone, entry: bookingEntry, telegramId: telegramId || null, telegramUsername: telegramUsername || null, name, confirmed: false });

    // Администратору — уведомление с кнопками подтвердить/отменить
    let contactLine;
    if (telegramUsername) {
      contactLine = `\n\n💬 Написать гостю: https://t.me/${telegramUsername}`;
    } else if (telegramId) {
      contactLine = `\n\n📩 Гость получил подтверждение от бота (у него нет username)`;
    } else {
      contactLine = `\n\n📱 Гость вне Telegram — бот не смог ему написать, свяжитесь по номеру телефона`;
    }

    let titleLine = '📅 Новая бронь!';
    if (room) titleLine = '📅 Новая бронь VIP-комнаты!';
    if (eventName) titleLine = '🎉 Бронь на мероприятие!';

    await sendTelegramMessage(
      ADMIN_CHAT_ID,
      `${titleLine}\n\n${details}${contactLine}`,
      {
        inline_keyboard: [[
          { text: '✅ Подтвердить', callback_data: `confirm:${bookingId}` },
          { text: '❌ Отменить', callback_data: `cancel_ask:${bookingId}` }
        ]]
      }
    );

    res.json({ status: existing ? 'updated' : 'created' });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to save booking' });
  }
});

// ─── ОТМЕНА БРОНИ ГОСТЕМ ИЛИ АДМИНОМ ЧЕРЕЗ ПРИЛОЖЕНИЕ ──

app.post('/api/booking/cancel', async (req, res) => {
  const { phone: rawPhone, entry } = req.body;
  const phone = normalizePhone(rawPhone);

  if (!phone || !entry) {
    return res.status(400).json({ error: 'phone and entry required' });
  }

  try {
    const result = await cancelBookingInternal(phone, entry);
    if (!result.ok) return res.status(404).json({ error: 'guest not found' });

    await sendTelegramMessage(ADMIN_CHAT_ID, `❌ Бронь отменена\n\n👤 ${result.guestName}\n📱 ${phone}\n🗓 ${displayEntry(entry)}`);

    res.json({ status: 'cancelled' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to cancel booking' });
  }
});

// ─── PROFILE → UPSERT BY PHONE ────────────────────

app.post('/api/profile', async (req, res) => {
  const { name, username, phone: rawPhone, birthday, telegramId } = req.body;
  const phone = normalizePhone(rawPhone);

  if (!phone) {
    return res.status(400).json({ error: 'phone required' });
  }

  try {
    const existing = await findGuestByPhone(phone);

    const properties = {};
    if (birthday) properties['Дата рождения'] = { date: { start: birthday } };
    if (username) properties['Telegram Username'] = { rich_text: [{ text: { content: username } }] };
    if (telegramId) properties['Telegram ID'] = { rich_text: [{ text: { content: String(telegramId) } }] };
    if (name) properties['Имя'] = { title: [{ text: { content: name } }] };

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

// ─── СТАТУС ПОСЛЕДНЕЙ АКТИВНОЙ БРОНИ ───────────────

app.get('/api/booking/status', async (req, res) => {
  const phone = req.query.phone;
  const checkKind = req.query.kind; // если указан — ищем бронь именно этого типа (стол/vip/событие)
  if (!phone) return res.status(400).json({ error: 'phone required' });

  try {
    const guest = await findGuestByPhone(phone);
    if (!guest) return res.json({ status: 'none' });

    const historyText = guest.properties['История броней']?.rich_text?.[0]?.plain_text || '';
    const entries = historyText.split(',').map(s => s.trim()).filter(Boolean);

    // Ищем последнюю активную (не отменённую, не истёкшую, при необходимости — того же типа) бронь
    let latestActive = null;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.includes('(отменено)')) continue;
      const parsed = parseEntry(e);
      if (isEntryExpired(parsed.iso)) continue;
      if (checkKind && parsed.kind !== checkKind) continue;
      latestActive = e;
      break;
    }

    if (!latestActive) return res.json({ status: 'none' });

    const raw = baseEntry(latestActive); // без статус-суффикса — нужен для отмены/опоздания
    const display = displayEntry(raw); // без ISO-префикса и типа — для показа гостю

    if (latestActive.includes('(подтверждено)')) {
      return res.json({ status: 'confirmed', entry: display, raw });
    }
    return res.json({ status: 'pending', entry: display, raw });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch status' });
  }
});

// ─── ВСЕ АКТИВНЫЕ БРОНИ ГОСТЯ (стол + vip + мероприятия одновременно) ──

app.get('/api/booking/status-all', async (req, res) => {
  const phone = req.query.phone;
  if (!phone) return res.status(400).json({ error: 'phone required' });

  try {
    const guest = await findGuestByPhone(phone);
    if (!guest) return res.json([]);

    const historyText = guest.properties['История броней']?.rich_text?.[0]?.plain_text || '';
    const entries = historyText.split(',').map(s => s.trim()).filter(Boolean);

    const active = [];
    for (const e of entries) {
      if (e.includes('(отменено)')) continue;
      const parsed = parseEntry(e);
      if (isEntryExpired(parsed.iso)) continue;

      const raw = baseEntry(e);
      const display = displayEntry(raw);
      const status = e.includes('(подтверждено)') ? 'confirmed' : 'pending';
      active.push({ status, entry: display, raw, kind: parsed.kind });
    }

    // Если несколько активных броней одного и того же типа — оставляем только самую свежую
    const latestByKind = {};
    for (const b of active) latestByKind[b.kind] = b;

    res.json(Object.values(latestByKind));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch statuses' });
  }
});

// ─── ГОСТЬ ЗАДЕРЖИВАЕТСЯ ────────────────────────────

app.post('/api/booking/late', async (req, res) => {
  const { phone: rawPhone, entry } = req.body;
  const phone = normalizePhone(rawPhone);

  if (!phone || !entry) {
    return res.status(400).json({ error: 'phone and entry required' });
  }

  try {
    const guest = await findGuestByPhone(phone);
    const guestName = guest?.properties?.['Имя']?.title?.[0]?.plain_text || 'Гость';

    await sendTelegramMessage(
      ADMIN_CHAT_ID,
      `⏰ Гость опаздывает на 15 минут\n\n👤 ${guestName}\n📱 ${phone}\n🗓 ${displayEntry(entry)}`
    );

    res.json({ status: 'notified' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to notify' });
  }
});

// ─── ADMIN: ВСЕ АКТИВНЫЕ БРОНИ ─────────────────────

app.get('/api/admin/bookings', async (req, res) => {
  try {
    let allResults = [];
    let cursor = undefined;
    do {
      const body = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const r = await fetch(`https://api.notion.com/v1/databases/${NOTION_GUESTS_DB_ID}/query`, {
        method: 'POST',
        headers: NOTION_HEADERS,
        body: JSON.stringify(body)
      });
      const data = await r.json();
      allResults = allResults.concat(data.results || []);
      cursor = data.has_more ? data.next_cursor : undefined;
    } while (cursor);

    const bookings = [];
    for (const page of allResults) {
      const props = page.properties;
      const name = props['Имя']?.title?.[0]?.plain_text || 'Гость';
      const phone = props['Телефон']?.phone_number || '';
      const history = props['История броней']?.rich_text?.[0]?.plain_text || '';
      if (!history) continue;
      const entries = history.split(',').map(s => s.trim()).filter(Boolean);
      for (const entry of entries) {
        if (entry.includes('(отменено)')) continue;
        const { iso } = splitEntry(entry);
        if (isEntryExpired(iso)) continue; // бронь уже прошла — не показываем как активную
        bookings.push({ name, phone, entry, display: displayEntry(entry) });
      }
    }

    res.json(bookings);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

// ─── TELEGRAM WEBHOOK (бот "На Крыше") ────────────

const WELCOME_TEXT =
  'Бронь, меню и новости На Крыше.\n' +
  'Нажимай кнопку «Открыть», чтобы найти всё, что нужно.\n\n' +
  'Можно бронировать и голосовым, что особенно удобно, если находишься за рулём. ' +
  'Просто назови дату, время и число гостей.\n' +
  'Ты говоришь: «столик на завтра в девять вечера на четверых». ' +
  'И ждёшь от нас сообщение с подтверждением.\n\n' +
  'Текстом здесь лучше не писать, ответа не будет. ' +
  'Хочешь связаться с командой? Заходи в приложение, через кнопку «Открыть».';

app.post('/telegram-webhook', async (req, res) => {
  const update = req.body;

  try {
    // Обычные сообщения — показываем приветствие с кнопкой открыть приложение
    if (update.message) {
      const chatId = update.message.chat.id;
      await sendTelegramMessage(chatId, WELCOME_TEXT, {
        inline_keyboard: [[{ text: 'Открыть', web_app: { url: WEBAPP_URL } }]]
      });
    }

    // Нажатие кнопки под уведомлением о брони
    if (update.callback_query) {
      const cq = update.callback_query;
      const [action, bookingId] = (cq.data || '').split(':');
      const record = bookingsMap.get(bookingId);

      if (!record) {
        await tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: 'Информация устарела', show_alert: false });
      } else if (action === 'confirm') {
        record.confirmed = true;
        await confirmBookingInternal(record.phone, record.entry);
        if (record.telegramId) {
          await sendTelegramMessage(record.telegramId, `🎉 Бронь подтверждена! Ждём вас.\n\n🗓 ${displayEntry(record.entry)}`);
        }
        await tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: '✅ Гостю отправлено подтверждение' });
        // Кнопку "Отменить" оставляем — вдруг гость передумает уже после подтверждения
        await tgApi('editMessageText', {
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text: `${cq.message.text}\n\n✅ ПОДТВЕРЖДЕНО`,
          reply_markup: {
            inline_keyboard: [[{ text: '❌ Отменить', callback_data: `cancel_ask:${bookingId}` }]]
          }
        });
      } else if (action === 'cancel_ask') {
        // Первое нажатие — просим подтвердить, чтобы случайное нажатие не отменяло бронь сразу
        await tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: 'Нажмите ещё раз для подтверждения' });
        await tgApi('editMessageReplyMarkup', {
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          reply_markup: {
            inline_keyboard: [[
              { text: '⚠️ Да, отменить', callback_data: `cancel:${bookingId}` },
              { text: '↩️ Назад', callback_data: `cancel_back:${bookingId}` }
            ]]
          }
        });
      } else if (action === 'cancel_back') {
        // Передумали отменять — возвращаем прежние кнопки
        await tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: '' });
        const restoredMarkup = record.confirmed
          ? { inline_keyboard: [[{ text: '❌ Отменить', callback_data: `cancel_ask:${bookingId}` }]] }
          : { inline_keyboard: [[
              { text: '✅ Подтвердить', callback_data: `confirm:${bookingId}` },
              { text: '❌ Отменить', callback_data: `cancel_ask:${bookingId}` }
            ]] };
        await tgApi('editMessageReplyMarkup', {
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          reply_markup: restoredMarkup
        });
      } else if (action === 'cancel') {
        const noSpotsMessage =
          `К сожалению, свободных мест на это время уже не осталось — вечер собрал больше гостей, чем мы ожидали.\n\n` +
          `Ваша бронь отменена, но крыша никуда не денётся: выберите другое время, и мы позаботимся, чтобы вечер получился особенным.`;
        // Если бронь ещё не была подтверждена — значит мы просто не смогли её принять (нет мест).
        // Если уже была подтверждена — значит гость просто не пришёл, тут другой тон уместнее.
        const cancelMessage = record.confirmed ? null : noSpotsMessage;
        await cancelBookingInternal(record.phone, record.entry, cancelMessage);
        await tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: '❌ Бронь отменена, гость уведомлён' });
        await tgApi('editMessageText', {
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text: `${cq.message.text}\n\n❌ ОТМЕНЕНО`
        });
        bookingsMap.delete(bookingId);
      }
    }
  } catch (error) {
    console.error('Webhook error:', error);
  }

  res.sendStatus(200);
});

app.get('/', (req, res) => {
  res.send('Notion Proxy for На Крыше is running ✅');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
