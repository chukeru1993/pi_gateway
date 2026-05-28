/**
 * deliver-file.ts — 文件交付工具
 *
 * Agent 生成文件后调用此工具，返回结构化下载标记。
 * 前端检测标记并渲染为 FileDownloadCard。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const DeliverFileParams = Type.Object({
	filePath: Type.String({ description: "Absolute path to the file" }),
	fileName: Type.Optional(Type.String({ description: "Display name for download (defaults to basename)" })),
	description: Type.Optional(Type.String({ description: "Brief description of the file" })),
});

export default function deliverFile(pi: ExtensionAPI) {
	pi.registerTool({
		name: "deliver_file",
		label: "Deliver File",
		description:
			"Deliver a generated file to the user. The file will appear as a downloadable card in the chat. Use this after generating files like SQL scripts, reports, or data exports.",
		parameters: DeliverFileParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const filePath = path.resolve(params.filePath);
			const fileName = params.fileName || path.basename(filePath);

			// 验证文件存在
			try {
				const stat = await fs.stat(filePath);
				if (!stat.isFile()) {
					return {
						content: [{ type: "text", text: `Error: ${filePath} is not a file` }],
						details: { error: "not_a_file" },
					};
				}
			} catch {
				return {
					content: [{ type: "text", text: `Error: File not found: ${filePath}` }],
					details: { error: "not_found" },
				};
			}

			// 构造下载链接（相对路径，前端拼接网关地址）
			// 链接格式：[下载 fileName](filePath)
			// 前端 Markdown 渲染器会检测此模式并转为 FileDownloadCard
			const desc = params.description ? `\n${params.description}` : "";
			const text = `文件已生成：${fileName}${desc}\n\n[下载 ${fileName}](${filePath})`;

			return {
				content: [{ type: "text", text }],
				details: {
					filePath,
					fileName,
					description: params.description,
				},
			};
		},
	});
}
