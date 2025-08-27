import axios from "axios";
import { Context } from "telegraf";
import { promises as fs } from "fs";
import path from "path";

export async function downloadPhotoToTmp(ctx: Context, fileId: string) {
  // @ts-ignore
  const fileLink: string = await ctx.telegram.getFileLink(fileId);
  const res = await axios.get<ArrayBuffer>(fileLink, { responseType: "arraybuffer" });
  const buf = Buffer.from(res.data);

  const dir = path.join(process.cwd(), "tmp");
  await fs.mkdir(dir, { recursive: true });
  const fp = path.join(dir, `${Date.now()}_${fileId}.jpg`);
  await fs.writeFile(fp, buf);
  return fp;
}
