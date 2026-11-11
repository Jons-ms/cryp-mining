'use strict';
const fs = require('fs');
const path = require('path');

/** Атомарний запис JSON: тимчасовий файл + rename, щоб не отримати напівзаписаний файл. */
function writeJsonAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e; // пошкоджений файл не перезаписуємо мовчки
  }
}

/**
 * Проста файлова база для першої версії (один процес сервера).
 * Усі зміни виконуються синхронно в пам'яті, тому кожна ігрова операція
 * атомарна відносно інших. Збереження на диск — з невеликою затримкою.
 *
 * ЗАМІНА НА FIRESTORE: інтерфейс (db, markDirty, flush) локалізований тут;
 * сервер залишається єдиним, хто змінює економіку.
 */
class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'db.json');
    this.db = readJson(this.file, null) || {
      players: {},     // playerId -> гравець
      nicknames: {},   // nickname(lowercase) -> playerId
      accounts: {},    // email(lowercase) -> { playerId, salt, hash, ... }
      sessions: {},    // sha256(token) -> { playerId, exp }
      podium: null,    // останній знімок Подіуму
    };
    this._dirty = false;
    this._timer = null;
  }

  markDirty() {
    this._dirty = true;
    if (!this._timer) {
      this._timer = setTimeout(() => {
        this._timer = null;
        this.flush();
      }, 1500);
      if (this._timer.unref) this._timer.unref();
    }
  }

  flush() {
    if (!this._dirty) return;
    writeJsonAtomic(this.file, this.db);
    this._dirty = false;
  }
}

module.exports = { Store, writeJsonAtomic, readJson };
