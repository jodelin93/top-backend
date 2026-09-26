/** URL-safe store handle from a name: "Café Olé #2" → "cafe-ole-2". */
export function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug.length >= 3 ? slug : `store-${slug || 'new'}`.slice(0, 40);
}
