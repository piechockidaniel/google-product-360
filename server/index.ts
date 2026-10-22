import path from 'node:path';

import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';

import type { Operation } from '../shared/types.js';
import { DemoStore } from './store.js';

const app = Fastify({ logger: true });
const projectRoot = process.cwd();
const databasePath = process.env.PRODUCT360_DB_PATH ?? path.join(projectRoot, 'data', 'product360.sqlite');
const store = new DemoStore(databasePath);
const scheduledOperations = new Set<string>();

function scheduleDemoOperation(operationId: string): void {
  if (scheduledOperations.has(operationId)) {
    return;
  }

  scheduledOperations.add(operationId);
  setTimeout(() => {
    try {
      store.startOperation(operationId);
      setTimeout(() => {
        try {
          store.completeOperation(operationId);
        } catch (error) {
          store.failOperation(operationId, error instanceof Error ? error.message : 'Demo operation failed.');
        } finally {
          scheduledOperations.delete(operationId);
        }
      }, 1200);
    } catch (error) {
      store.failOperation(operationId, error instanceof Error ? error.message : 'Demo operation failed.');
      scheduledOperations.delete(operationId);
    }
  }, 250);
}

for (const operationId of store.getPendingOperationIds()) {
  scheduleDemoOperation(operationId);
}

app.get('/healthz', async () => ({ ok: true, mode: 'demo', storage: 'sqlite' }));

app.get('/api/mode', async () => ({ mode: 'demo' }));

app.get('/api/products', async () => ({
  mode: 'demo',
  products: store.listProducts(),
}));

app.get('/api/products/:productId', async (request, reply) => {
  const { productId } = request.params as { productId: string };
  const product = store.findProduct(productId);
  if (!product) {
    return reply.code(404).send({ error: 'Product not found' });
  }
  return product;
});

app.post('/api/operations', async (request, reply) => {
  const body = request.body as { productId?: string; issueCode?: string } | undefined;
  if (!body?.productId || !body.issueCode) {
    return reply.code(400).send({ error: 'productId and issueCode are required' });
  }

  const product = store.findProduct(body.productId);
  const issue = product?.issues.find((item) => item.code === body.issueCode);
  if (!product || !issue) {
    return reply.code(404).send({ error: 'Product issue not found' });
  }
  if (!issue.predictable || issue.classification !== 'quick-fix') {
    return reply.code(422).send({ error: 'This issue requires user review and cannot use Quick Fix.' });
  }
  if (store.hasActiveOperation(product.id, issue.code)) {
    return reply.code(409).send({ error: 'An operation for this issue is already running.' });
  }

  const operation = store.createOperation(product.id, issue.code);
  scheduleDemoOperation(operation.id);
  return reply.code(202).send(operation);
});

app.get('/api/operations/:operationId', async (request, reply): Promise<Operation | object> => {
  const { operationId } = request.params as { operationId: string };
  const operation = store.getOperation(operationId);
  if (!operation) {
    return reply.code(404).send({ error: 'Operation not found' });
  }
  return operation;
});

const clientDirectory = path.join(projectRoot, 'dist', 'client');
app.register(fastifyStatic, {
  root: clientDirectory,
  prefix: '/',
});

app.setNotFoundHandler(async (request, reply) => {
  if (request.method === 'GET' && !request.url.startsWith('/api/') && request.url !== '/healthz') {
    return reply.sendFile('index.html');
  }

  return reply.code(404).send({ error: 'Not found' });
});

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 3000);

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
