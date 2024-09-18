const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bodyParser = require('body-parser');
const path = require('path');
const sharedsession = require('express-socket.io-session');

// Инициализация приложения Express
const app = express();

// Создание HTTP-сервера
const server = http.createServer(app);

// Инициализация Socket.IO
const io = socketIo(server);

// Подключение к базе данных PostgreSQL
const pool = new Pool({
  connectionString: 'postgresql://postgres:docup2005@localhost:5432/chat',
});

// Настройка сессий
const sessionMiddleware = session({
  store: new pgSession({
    pool: pool,
    tableName: 'session',
  }),
  secret: 'your_secret_key',
  resave: false,
  saveUninitialized: false,
});

// Использование сессий в Express и Socket.IO
app.use(sessionMiddleware);
io.use(sharedsession(sessionMiddleware, {
  autoSave: true,
}));

// Настройка шаблонизатора EJS
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// Подключение статических файлов из папки "public"
app.use(express.static('public'));

// Использование body-parser для обработки данных из форм
app.use(bodyParser.urlencoded({ extended: true }));

// Проверка аутентификации пользователя
function checkAuth(req, res, next) {
  if (req.session && req.session.userId) {
    next();
  } else {
    res.redirect('/login');
  }
}

// Регистрация пользователя
app.get('/register', (req, res) => {
  res.sendFile(__dirname + '/public/register.html');
});

app.post('/register', async (req, res) => {
  const { username, password } = req.body;

  // Хеширование пароля
  const hashedPassword = await bcrypt.hash(password, 10);

  // Сохранение пользователя в базе данных
  try {
    await pool.query('INSERT INTO users (username, password) VALUES ($1, $2)', [username, hashedPassword]);
    res.redirect('/login');
  } catch (err) {
    console.error(err);
    res.send('Ошибка при регистрации');
  }
});

// Авторизация пользователя
app.get('/login', (req, res) => {
  res.sendFile(__dirname + '/public/login.html');
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  // Поиск пользователя в базе данных
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);

    if (result.rows.length > 0) {
      const user = result.rows[0];

      // Проверка пароля
      if (await bcrypt.compare(password, user.password)) {
        // Создание сессии пользователя
        req.session.userId = user.id;
        req.session.username = user.username;
        res.redirect('/chat');
      } else {
        res.send('Неверный пароль');
      }
    } else {
      res.send('Пользователь не найден');
    }
  } catch (err) {
    console.error(err);
    res.send('Ошибка при авторизации');
  }
});

// Выход пользователя
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// Страница чата (требует аутентификации)
app.get('/chat', checkAuth, (req, res) => {
  res.render('chat', { username: req.session.username });
});

// Список подключенных пользователей
const onlineUsers = {};

// Обработка событий Socket.IO
io.on('connection', (socket) => {
  console.log('Пользователь подключился');

  // Получение данных пользователя из сессии
  const session = socket.handshake.session;
  const userId = session.userId;
  const username = session.username;

  if (!username) {
    console.log('Не удалось получить имя пользователя из сессии');
    return;
  }

  // Сохранение имени пользователя в сокете
  socket.username = username;

  // Добавляем сокет в список подключенных пользователей
  onlineUsers[username] = socket;

  // Присоединение к комнате по умолчанию
  let currentRoom = 'general';
  socket.join(currentRoom);

  // Отправка списка онлайн пользователей
  io.emit('online users', Object.keys(onlineUsers));

  socket.on('join room', async (room) => {
    socket.leave(currentRoom);
    currentRoom = room;
    socket.join(room);
    console.log(`Пользователь ${username} присоединился к комнате ${room}`);

    // Получение последних 50 сообщений из комнаты
    try {
      const result = await pool.query(
          'SELECT users.username, messages.content FROM messages INNER JOIN users ON messages.user_id = users.id WHERE room = $1 ORDER BY timestamp ASC LIMIT 50',
          [room]
      );
      const messagesData = result.rows.map((row) => `${row.username}: ${row.content}`);
      socket.emit('previous messages', messagesData);
    } catch (err) {
      console.error(err);
    }
  });

  socket.on('chat message', async (data) => {
    const { room, message } = data;

    // Сохранение сообщения в базе данных
    try {
      await pool.query('INSERT INTO messages (user_id, content, room) VALUES ($1, $2, $3)', [userId, message, room]);
    } catch (err) {
      console.error(err);
    }

    // Отправка сообщения в определенную комнату
    io.to(room).emit('chat message', { message: `${username}: ${message}`, room: room });
  });

  socket.on('private message', async (data) => {
    const { to, message } = data;
    const targetSocket = onlineUsers[to];

    // Найти recipient_id по имени пользователя
    let recipientId;
    try {
      const result = await pool.query('SELECT id FROM users WHERE username = $1', [to]);
      if (result.rows.length > 0) {
        recipientId = result.rows[0].id;
      } else {
        socket.emit('private message', { from: 'Сервер', message: 'Пользователь не найден' });
        return;
      }
    } catch (err) {
      console.error(err);
      socket.emit('private message', { from: 'Сервер', message: 'Ошибка сервера' });
      return;
    }

    // Сохранение сообщения в базе данных
    try {
      await pool.query('INSERT INTO messages (user_id, content, recipient_id) VALUES ($1, $2, $3)', [userId, message, recipientId]);
    } catch (err) {
      console.error(err);
    }

    if (targetSocket) {
      targetSocket.emit('private message', { from: username, message: message });
      socket.emit('private message', { from: `Вы (для ${to})`, message: message });
    } else {
      socket.emit('private message', { from: 'Сервер', message: 'Пользователь не в сети' });
    }
  });

  // Обработка отключения пользователя
  socket.on('disconnect', () => {
    console.log(`Пользователь ${username} отключился`);
    delete onlineUsers[username];
    io.emit('online users', Object.keys(onlineUsers));
  });
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
