import type { Types } from 'mongoose';
import { config } from '../config.js';
import { Member, Notification, User } from '../models/index.js';

interface NotifyInput {
  workspaceId: Types.ObjectId;
  type: string;
  title: string;
  body: string;
  link: string;
  email: boolean;
}

let transporterPromise: Promise<{ sendMail: (o: Record<string, unknown>) => Promise<unknown> } | null> | null = null;
function transporter() {
  if (!transporterPromise) {
    transporterPromise = config.smtpUrl
      ? import('nodemailer').then((m) => m.default.createTransport(config.smtpUrl) as never)
      : Promise.resolve(null);
  }
  return transporterPromise;
}

/** In-app notification for every workspace member, plus optional email. */
export async function notifyWorkspace(input: NotifyInput) {
  const members = await Member.find({ workspaceId: input.workspaceId }).lean();
  const users = await User.find({ _id: { $in: members.map((m) => m.userId) } }).lean();
  const mailer = input.email ? await transporter() : null;
  for (const u of users) {
    const n = await Notification.create({
      userId: u._id,
      workspaceId: input.workspaceId,
      type: input.type,
      title: input.title,
      body: input.body,
      link: input.link,
    });
    if (input.email) {
      if (mailer) {
        try {
          await mailer.sendMail({
            from: config.mailFrom,
            to: u.email,
            subject: input.title,
            text: `${input.body}\n\n${config.appUrl}${input.link}`,
          });
          await Notification.updateOne({ _id: n._id }, { emailed: true });
        } catch (err) {
          console.warn('[notify] email failed:', (err as Error).message);
        }
      } else {
        console.log(`[notify] (email not configured) would email ${u.email}: ${input.title}`);
      }
    }
  }
}
