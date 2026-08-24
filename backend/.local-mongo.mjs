import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { writeFileSync } from 'node:fs';

const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
const uri = replSet.getUri();
writeFileSync('.local-mongo-uri.txt', uri);
console.log('LOCAL_MONGO_READY', uri);

process.on('SIGINT', async () => { await replSet.stop(); process.exit(0); });
process.on('SIGTERM', async () => { await replSet.stop(); process.exit(0); });
