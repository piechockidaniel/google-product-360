export type ProductStatus = 'Approved' | 'Limited' | 'Disapproved';

export type ProductIssue = {
  code: string;
  title: string;
  severity: 'warning' | 'error';
  predictable: boolean;
  source: 'product' | 'account';
  evidence: string;
  consequence: string;
  remediation: string;
  classification: 'quick-fix' | 'review';
};

export type Product = {
  id: string;
  title: string;
  supplier: string;
  feed: string;
  price: string;
  availability: string;
  status: ProductStatus;
  issueSummary: string;
  issues: ProductIssue[];
  thumbnailLabel: string;
  thumbnailColor: string;
};

export type ProductsResponse = {
  mode: 'demo' | 'live';
  products: Product[];
};

export type OperationStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export type OperationEvent = {
  id: number;
  operationId: string;
  type: string;
  message: string;
  createdAt: string;
};

export type Operation = {
  id: string;
  productId: string;
  issueCode: string;
  status: OperationStatus;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  resultMessage: string | null;
  events: OperationEvent[];
};
