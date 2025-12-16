const express = require("express");
const { Pool } = require("pg");
const { createClient } = require("redis");

const app = express();
app.use(express.json());

// Config
const PORT = parseInt(process.env.PORT || "3000", 10);

const DB_USER = process.env.DB_USER;
const DB_PASSWORD = process.env.DB_PASSWORD;
const DB_NAME = process.env.DB_NAME;

const WRITE_DB_HOST = process.env.WRITE_DB_HOST;
const WRITE_DB_PORT = parseInt(process.env.WRITE_DB_PORT || "5432", 10);

const READ_DB_HOST = process.env.READ_DB_HOST;
const READ_DB_PORT = parseInt(process.env.READ_DB_PORT || "5432", 10);

const REDIS_HOST = process.env.REDIS_HOST;
const REDIS_PORT = parseInt(process.env.REDIS_PORT || "6379", 10);

const CACHE_TTL_SECONDS = parseInt(process.env.CACHE_TTL_SECONDS || "60", 10);

const writePool = new Pool({
    host: WRITE_DB_HOST,
    port: WRITE_DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME
});

const readPool = new Pool({
    host: READ_DB_HOST,
    port: READ_DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME
});

async function queryRead(text, params) {
    return await readPool.query(text, params);
}

// Redis
const redis = createClient({
    url: `redis://${REDIS_HOST}:${REDIS_PORT}`
});

let redisReady = false;

redis.on("ready", () => {
    redisReady = true;
});

redis.on("end", () => {
    redisReady = false;
});

redis.on("error", () => {
    redisReady = false;
});

function ensureRedis(res) {
    if (!redisReady) {
        res.status(503).json({ error: "Redis unavailable" });
        return false;
    }
    return true;
}

async function cacheGet(key) {
    if (!redisReady) throw new Error("Redis unavailable");
    return await redis.get(key);
}

async function cacheSet(key, value, ttlSeconds) {
    if (!redisReady) throw new Error("Redis unavailable");
    await redis.set(key, value, { EX: ttlSeconds });
}

async function cacheDel(key) {
    if (!redisReady) throw new Error("Redis unavailable");
    await redis.del(key);
}


// ROUTES
app.get("/health", async (req, res) => {
    res.json({ ok: true, redis: redisReady });
});

// READ (replica) - list
app.get("/products", async (req, res) => {
    const r = await queryRead("SELECT * FROM products ORDER BY id ASC", []);
    res.json(r.rows);
});

// READ (replica) + cache-aside - GET /products/:id
app.get("/products/:id", async (req, res) => {
    if (!ensureRedis(res)) return;

    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

    const key = `product:${id}`;

    // 1) Try cache
    try {
        const cached = await cacheGet(key);
        if (cached) {
            res.setHeader("X-Cache", "HIT");
            return res.json(JSON.parse(cached));
        }
    } catch {
        return res.status(503).json({ error: "Redis unavailable" });
    }

    // 2) Cache miss -> DB (replica)
    const r = await queryRead("SELECT * FROM products WHERE id = $1", [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: "Not found" });

    // 3) Put in cache with TTL
    try {
        await cacheSet(key, JSON.stringify(r.rows[0]), CACHE_TTL_SECONDS); // TTL 30-120s
    } catch {
        return res.status(503).json({ error: "Redis unavailable" });
    }

    res.setHeader("X-Cache", "MISS");
    res.json(r.rows[0]);
});

// WRITE (primary via HAProxy) — create
app.post("/products", async (req, res) => {
    const { name, price_cents } = req.body || {};
    if (!name || !Number.isInteger(price_cents)) {
        return res.status(400).json({ error: "Expected { name, price_cents:int }" });
    }

    const r = await writePool.query(
        "INSERT INTO products(name, price_cents, updated_at) VALUES ($1, $2, NOW()) RETURNING *",
        [name, price_cents]
    );

    res.status(201).json(r.rows[0]);
});

// WRITE (primary) + invalidation - PUT /products/:id
app.put("/products/:id", async (req, res) => {
    if (!ensureRedis(res)) return;

    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

    const { name, price_cents } = req.body || {};
    if (!name || !Number.isInteger(price_cents)) {
        return res.status(400).json({ error: "Expected { name, price_cents:int }" });
    }

    // 1) Update on primary
    const r = await writePool.query(
        "UPDATE products SET name=$1, price_cents=$2, updated_at=NOW() WHERE id=$3 RETURNING *",
        [name, price_cents, id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: "Not found" });

    // 2) Invalidate cache key
    try {
        await cacheDel(`product:${id}`); // suppression demandée
    } catch {
        return res.status(503).json({ error: "Redis unavailable" });
    }

    res.json(r.rows[0]);
});

// --------------------
// Start
// --------------------
(async () => {
    await redis.connect().catch(() => {});

    app.listen(PORT, () => {
        console.log(`API listening on :${PORT}`);
        console.log(`reads: ${READ_DB_HOST}:${READ_DB_PORT} | writes: ${WRITE_DB_HOST}:${WRITE_DB_PORT}`);
        console.log(`cache: redis://${REDIS_HOST}:${REDIS_PORT} ttl=${CACHE_TTL_SECONDS}s`);
    });
})();
