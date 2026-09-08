export function modelName(id, labels = {}, short = false) {
  const label = labels?.[id] || String(id ?? '');
  return short && !labels?.[id] ? label.split('/').slice(1).join('/') || label : label;
}
