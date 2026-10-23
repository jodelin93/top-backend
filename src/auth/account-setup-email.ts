/**
 * The "choose your password" e-mail sent to someone added to a store: opening
 * the link sets their password and confirms their e-mail address.
 */
import { resetLanguage, type ResetLanguage } from './password-reset-email';

const TEXTS: Record<
  ResetLanguage,
  {
    subject: (store: string) => string;
    hello: (name: string) => string;
    intro: (store: string) => string;
    button: string;
    expires: (hours: number) => string;
    ignore: string;
  }
> = {
  en: {
    subject: (s) => (s ? `${s}: choose your password` : 'Choose your password'),
    hello: (n) => (n ? `Hello ${n},` : 'Hello,'),
    intro: (s) =>
      `An account was created for you${s ? ` at ${s}` : ''} on the Point of Sale. To confirm this e-mail address and choose your password, open this link:`,
    button: 'Choose my password',
    expires: (h) =>
      `The link works once and expires in ${h} hours. You can then sign in with this e-mail address and your password.`,
    ignore:
      'If you were not expecting this, ignore this e-mail: nobody can use the account without this link.',
  },
  fr: {
    subject: (s) =>
      s
        ? `${s} : choisissez votre mot de passe`
        : 'Choisissez votre mot de passe',
    hello: (n) => (n ? `Bonjour ${n},` : 'Bonjour,'),
    intro: (s) =>
      `Un compte a été créé pour vous${s ? ` chez ${s}` : ''} sur la caisse. Pour confirmer cette adresse e-mail et choisir votre mot de passe, ouvrez ce lien :`,
    button: 'Choisir mon mot de passe',
    expires: (h) =>
      `Le lien ne sert qu’une fois et expire dans ${h} heures. Vous pourrez ensuite vous connecter avec cette adresse e-mail et votre mot de passe.`,
    ignore:
      'Si vous ne vous y attendiez pas, ignorez cet e-mail : personne ne peut utiliser le compte sans ce lien.',
  },
  ht: {
    subject: (s) => (s ? `${s}: chwazi modpas ou` : 'Chwazi modpas ou'),
    hello: (n) => (n ? `Bonjou ${n},` : 'Bonjou,'),
    intro: (s) =>
      `Yo kreye yon kont pou ou${s ? ` nan ${s}` : ''} sou kès la. Pou konfime adrès imèl sa a epi chwazi modpas ou, louvri lyen sa a:`,
    button: 'Chwazi modpas mwen',
    expires: (h) =>
      `Lyen an mache yon sèl fwa epi li ekspire nan ${h} èdtan. Apre sa, ou ka konekte ak adrès imèl sa a ak modpas ou.`,
    ignore:
      'Si ou pa t ap tann sa, pa okipe imèl sa a: pèsonn pa ka sèvi ak kont lan san lyen sa a.',
  },
  es: {
    subject: (s) => (s ? `${s}: elija su contraseña` : 'Elija su contraseña'),
    hello: (n) => (n ? `Hola ${n}:` : 'Hola:'),
    intro: (s) =>
      `Se creó una cuenta para usted${s ? ` en ${s}` : ''} en el punto de venta. Para confirmar esta dirección de correo y elegir su contraseña, abra este enlace:`,
    button: 'Elegir mi contraseña',
    expires: (h) =>
      `El enlace funciona una sola vez y caduca en ${h} horas. Después podrá iniciar sesión con este correo y su contraseña.`,
    ignore:
      'Si no lo esperaba, ignore este correo: nadie puede usar la cuenta sin este enlace.',
  },
};

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ] as string,
  );

export function accountSetupEmail(input: {
  link: string;
  firstName?: string | null;
  storeName?: string | null;
  language: unknown;
  hours: number;
}): { subject: string; text: string; html: string } {
  const tx = TEXTS[resetLanguage(input.language)];
  const name = (input.firstName ?? '').trim();
  const store = (input.storeName ?? '').trim();
  const subject = tx.subject(store);
  const text = [
    tx.hello(name),
    '',
    tx.intro(store),
    input.link,
    '',
    tx.expires(input.hours),
    tx.ignore,
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#111827">
<div style="max-width:520px;margin:24px auto;background:#ffffff;border-radius:12px;padding:28px">
${store ? `<p style="margin:0 0 16px;font-size:13px;color:#6b7280">${escapeHtml(store)}</p>` : ''}
<h1 style="margin:0 0 16px;font-size:20px">${escapeHtml(tx.button)}</h1>
<p style="margin:0 0 12px;font-size:15px;line-height:1.5">${escapeHtml(tx.hello(name))}</p>
<p style="margin:0 0 20px;font-size:15px;line-height:1.5">${escapeHtml(tx.intro(store))}</p>
<p style="margin:0 0 20px"><a href="${escapeHtml(input.link)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:8px">${escapeHtml(tx.button)}</a></p>
<p style="margin:0 0 12px;font-size:13px;line-height:1.5;color:#4b5563">${escapeHtml(tx.expires(input.hours))}</p>
<p style="margin:0 0 12px;font-size:13px;line-height:1.5;color:#4b5563">${escapeHtml(tx.ignore)}</p>
<p style="margin:16px 0 0;font-size:12px;color:#9ca3af;word-break:break-all">${escapeHtml(input.link)}</p>
</div></body></html>`;
  return { subject, text, html };
}
