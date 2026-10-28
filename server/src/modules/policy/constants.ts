/**
 * Policy thresholds, each traceable to the KB sentence it implements.
 * If a policy document changes, this file is the single place to update.
 */
export const POLICY = {
  /** KB-REFUND-001: "returned within 7 calendar days of delivery" */
  returnWindowDays: { value: 7, docId: 'KB-REFUND-001' },
  /** KB-WARRANTY-001: "Electronics have a 12-month limited warranty from delivery date" */
  warrantyMonths: { value: 12, docId: 'KB-WARRANTY-001' },
  /** KB-WARRANTY-001: "Gold-tier customers receive a 6-month warranty extension on eligible hardware" */
  goldExtensionMonths: { value: 6, docId: 'KB-WARRANTY-001' },
  /** KB-WARRANTY-001: extension excludes "accessories under INR 3000" */
  goldExtensionAccessoryMinInr: { value: 3000, docId: 'KB-WARRANTY-001' },
  /** KB-SHIPPING-001: "Most orders ship within 1 business day" */
  dispatchBusinessDays: { value: 1, docId: 'KB-SHIPPING-001' },
  /** KB-SHIPPING-001: "no movement for 5 or more business days ... open a carrier investigation" */
  staleTrackingBusinessDays: { value: 5, docId: 'KB-SHIPPING-001' },
  /** KB-SHIPPING-001: replacement/refund "after 10 business days without movement" */
  lostPackageBusinessDays: { value: 10, docId: 'KB-SHIPPING-001' },
  /** KB-COUPON-001: "maximum coupon value for standard approval is INR 1000" */
  couponMaxInr: { value: 1000, docId: 'KB-COUPON-001' },
} as const;

/** KB-REFUND-001: "Software licenses, downloadable products, gift cards ... are not eligible for refund" */
export const NON_RETURNABLE_CATEGORIES = ['software', 'digital', 'download', 'gift_card'] as const;
