import path from 'node:path';

import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';

import type { Product, ProductsResponse } from '../shared/types.js';

const projectRoot = process.cwd();

const demoProducts: Product[] = [
  {
    id: 'demo-wooden-kitchen-001',
    title: 'Wooden Play Kitchen with Accessories',
    supplier: 'Magia Zabawek',
    feed: 'main-products.xml',
    price: '649.00 PLN',
    availability: 'In stock',
    status: 'Limited',
    issueSummary: 'Missing GTIN',
    issues: [
      {
        code: 'missing_gtin',
        title: 'Missing GTIN',
        severity: 'warning',
        predictable: true,
      },
    ],
    thumbnailLabel: 'PK',
    thumbnailColor: '#f5c26b',
  },
  {
    id: 'demo-magnetic-blocks-002',
    title: 'Magnetic Building Blocks — 64 Pieces',
    supplier: 'Bright Blocks',
    feed: 'main-products.xml',
    price: '119.90 PLN',
    availability: 'In stock',
    status: 'Approved',
    issueSummary: 'No active issues',
    issues: [],
    thumbnailLabel: 'MB',
    thumbnailColor: '#9ed8c6',
  },
  {
    id: 'demo-forest-puzzle-003',
    title: 'Forest Animals Wooden Puzzle',
    supplier: 'Little Forest',
    feed: 'seasonal.tsv',
    price: '44.50 PLN',
    availability: 'Out of stock',
    status: 'Disapproved',
    issueSummary: 'Price mismatch · Landing page',
    issues: [
      {
        code: 'price_mismatch',
        title: 'Price does not match the landing page',
        severity: 'error',
        predictable: false,
      },
      {
        code: 'landing_page',
        title: 'Landing page cannot be verified',
        severity: 'error',
        predictable: false,
      },
    ],
    thumbnailLabel: 'FP',
    thumbnailColor: '#b8c8eb',
  },
  {
    id: 'demo-cotton-rabbit-004',
    title: 'Organic Cotton Rabbit Comforter',
    supplier: 'Soft Nest',
    feed: 'main-products.xml',
    price: '79.00 PLN',
    availability: 'In stock',
    status: 'Limited',
    issueSummary: 'Image quality',
    issues: [
      {
        code: 'image_quality',
        title: 'Image resolution is below the recommended threshold',
        severity: 'warning',
        predictable: true,
      },
    ],
    thumbnailLabel: 'CR',
    thumbnailColor: '#e8b7c7',
  },
];

const app = Fastify({ logger: true });

app.get('/healthz', async () => ({ ok: true, mode: 'demo' }));

app.get('/api/mode', async () => ({ mode: 'demo' }));

app.get('/api/products', async (): Promise<ProductsResponse> => ({
  mode: 'demo',
  products: demoProducts,
}));

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
