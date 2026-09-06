// Customer relationships come from exact provider IDs and email addresses.
// Choosing a case does not write to any provider or invent a customer history.
export function emailAddresses(value) {
  return [...new Set((String(value ?? '').toLowerCase().match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+/g) ?? []).map(item => item.replace(/[.,;]+$/, '')))];
}
function header(message, name) {
  return message[name] ?? message.payload?.headers?.find(item => item.name.toLowerCase() === name)?.value ?? '';
}
function messageTime(message) {
  const internal = Number(message.internalDate);
  if (Number.isFinite(internal) && internal > 0) return internal;
  const date = Date.parse(header(message, 'date'));
  return Number.isFinite(date) ? date : 0;
}
function invoiceAmount(invoice) {
  const currency = String(invoice.currency ?? 'usd').toUpperCase();
  const value = invoice.amount_remaining ?? invoice.amount_due ?? invoice.total ?? 0;
  try {
    const formatter = new Intl.NumberFormat('en', { style: 'currency', currency });
    return formatter.format(value / 10 ** formatter.resolvedOptions().maximumFractionDigits);
  } catch { return `${value} minor units (${currency})`; }
}
export function buildDemoStories(data = {}) {
  const customers = data.stripe?.customers ?? [];
  const invoices = data.stripe?.invoices ?? [];
  const messages = data.gmail?.messages ?? [];
  return customers.map(customer => {
    const address = String(customer.email ?? '').toLowerCase();
    const incoming = messages.filter(message => address && emailAddresses(header(message, 'from')).includes(address)).sort((a, b) => messageTime(b) - messageTime(a));
    const message = incoming[0] ?? null;
    const open = invoices.filter(invoice => (typeof invoice.customer === 'object' ? invoice.customer?.id : invoice.customer) === customer.id && invoice.status === 'open').sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
    const invoice = open[0] ?? null;
    if (!message && !invoice) return null;
    const subject = String(message ? header(message, 'subject') || 'Your account' : 'Your account invoice');
    const invoiceName = invoice?.number || invoice?.id;
    const evidence = [];
    if (message) evidence.push({ service: 'Gmail', label: 'Customer message', detail: subject, record: message });
    if (invoice) evidence.push({ service: 'Stripe', label: 'Open invoice', detail: `${invoiceName} · ${invoiceAmount(invoice)} · Open`, record: invoice });
    const text = message
      ? `Hello,\n\nThank you for your message about “${subject.replace(/^re:\s*/i, '')}”.${invoice ? ` I am also reviewing invoice ${invoiceName}, which is currently open.` : ''}\n\nI will check the details and follow up with an update.\n\nThank you` 
      : `Hello,\n\nI am following up on invoice ${invoiceName}, which is currently open for ${invoiceAmount(invoice)}. Please let me know if you need any information from our team.\n\nThank you`;
    const messageId = message?.headers?.['message-id'] ?? message?.payload?.headers?.find(item => item.name.toLowerCase() === 'message-id')?.value;
    const existingReferences = message?.headers?.references ?? message?.payload?.headers?.find(item => item.name.toLowerCase() === 'references')?.value ?? '';
    const thread = message?.threadId && messageId ? { threadId: message.threadId, inReplyTo: messageId, references: [...new Set(`${existingReferences} ${messageId}`.trim().split(/\s+/))].join(' ') } : {};
    return {
      id: String(customer.id), customer, invoice, message, evidence,
      title: message ? `Follow up with ${customer.name || customer.email}` : `Review ${customer.name || customer.email}'s open invoice`,
      reason: message && invoice ? 'A customer message and an open invoice are available. Read both before you contact the customer.' : message ? 'A customer has written to your team. Read the message, then prepare a follow-up.' : 'This invoice is open. Review it before you contact the customer.',
      reply: { to: customer.email || '', subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`, text, ...thread },
      canReply: Boolean(address), latest: messageTime(message ?? {}),
    };
  }).filter(Boolean).sort((a, b) => Number(Boolean(b.message && b.invoice)) - Number(Boolean(a.message && a.invoice)) || Number(Boolean(b.message)) - Number(Boolean(a.message)) || b.latest - a.latest || a.id.localeCompare(b.id));
}
