/**
 * The "reset your password" e-mail, in the language the person was using on the
 * sign-in page (en, fr, ht, es; English otherwise).
 */
export const RESET_LANGUAGES = ['en', 'fr', 'ht', 'es'] as const;
export type ResetLanguage = (typeof RESET_LANGUAGES)[number];

const TEXTS: Record<
  ResetLanguage,
  {
    subject: string;
    hello: (name: string) => string;
    intro: string;
    button: string;
    expires: (minutes: number) => string;
    ignore: string;
  }
> = {
  en: {
    subject: 'Reset your password',
    hello: (name) => (name ? `Hello ${name},` : 'Hello,'),
    intro:
      'Someone asked to reset the password of your Point of Sale account. To choose a new password, open this link:',
    button: 'Choose a new password',
    expires: (m) =>
      `The link works once and expires in ${m} minutes. Signing in afterwards signs out your other devices.`,
    ignore:
      "If you didn't ask for this, ignore this e-mail: your password stays the same.",
  },
  fr: {
    subject: 'Réinitialiser votre mot de passe',
    hello: (name) => (name ? `Bonjour ${name},` : 'Bonjour,'),
    intro:
      'Une demande de réinitialisation du mot de passe de votre compte de caisse a été faite. Pour choisir un nouveau mot de passe, ouvrez ce lien :',
    button: 'Choisir un nouveau mot de passe',
    expires: (m) =>
      `Le lien ne sert qu’une fois et expire dans ${m} minutes. Vos autres appareils seront déconnectés.`,
    ignore:
      'Si vous n’êtes pas à l’origine de cette demande, ignorez cet e-mail : votre mot de passe ne change pas.',
  },
  ht: {
    subject: 'Chanje modpas ou',
    hello: (name) => (name ? `Bonjou ${name},` : 'Bonjou,'),
    intro:
      'Yon moun mande pou chanje modpas kont kès ou a. Pou chwazi yon nouvo modpas, louvri lyen sa a:',
    button: 'Chwazi yon nouvo modpas',
    expires: (m) =>
      `Lyen an mache yon sèl fwa epi li ekspire nan ${m} minit. Lòt aparèy ou yo ap dekonekte.`,
    ignore: 'Si se pa ou ki mande sa, pa okipe imèl sa a: modpas ou pa chanje.',
  },
  es: {
    subject: 'Restablecer su contraseña',
    hello: (name) => (name ? `Hola ${name}:` : 'Hola:'),
    intro:
      'Alguien pidió restablecer la contraseña de su cuenta del punto de venta. Para elegir una nueva contraseña, abra este enlace:',
    button: 'Elegir una nueva contraseña',
    expires: (m) =>
      `El enlace funciona una sola vez y caduca en ${m} minutos. Sus otros dispositivos se cerrarán.`,
    ignore:
      'Si no lo pidió usted, ignore este correo: su contraseña no cambia.',
  },
};

export const resetLanguage = (value: unknown): ResetLanguage =>
  RESET_LANGUAGES.includes(value as ResetLanguage)
    ? (value as ResetLanguage)
    : 'en';

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ] as string,
  );

export function passwordResetEmail(input: {
  link: string;
  firstName?: string | null;
  storeName?: string | null;
  language: ResetLanguage;
  minutes: number;
}): { subject: string; text: string; html: string } {
  const tx = TEXTS[input.language];
  const name = (input.firstName ?? '').trim();
  const store = (input.storeName ?? '').trim();
  const subject = store ? `${store}: ${tx.subject}` : tx.subject;
  const text = [
    tx.hello(name),
    '',
    tx.intro,
    input.link,
    '',
    tx.expires(input.minutes),
    tx.ignore,
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#111827">
<div style="max-width:520px;margin:24px auto;background:#ffffff;border-radius:12px;padding:28px">
${store ? `<p style="margin:0 0 16px;font-size:13px;color:#6b7280">${escapeHtml(store)}</p>` : ''}
<h1 style="margin:0 0 16px;font-size:20px">${escapeHtml(tx.subject)}</h1>
<p style="margin:0 0 12px;font-size:15px;line-height:1.5">${escapeHtml(tx.hello(name))}</p>
<p style="margin:0 0 20px;font-size:15px;line-height:1.5">${escapeHtml(tx.intro)}</p>
<p style="margin:0 0 20px"><a href="${escapeHtml(input.link)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:8px">${escapeHtml(tx.button)}</a></p>
<p style="margin:0 0 12px;font-size:13px;line-height:1.5;color:#4b5563">${escapeHtml(tx.expires(input.minutes))}</p>
<p style="margin:0 0 12px;font-size:13px;line-height:1.5;color:#4b5563">${escapeHtml(tx.ignore)}</p>
<p style="margin:16px 0 0;font-size:12px;color:#9ca3af;word-break:break-all">${escapeHtml(input.link)}</p>
</div></body></html>`;
  return { subject, text, html };
}
