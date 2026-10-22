export type ProductStatus = 'Approved' | 'Limited' | 'Disapproved';

export type ProductIssue = {
  code: string;
  title: string;
  severity: 'warning' | 'error';
  predictable: boolean;
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
