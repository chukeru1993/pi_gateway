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

			// 验证文件存在且大小 > 0
			try {
				const stat = await fs.stat(filePath);
				if (!stat.isFile()) {
					return {
						content: [{ type: "text", text: `Error: ${filePath} is not a file` }],
						details: { error: "not_a_file" },
					};
				}
				if (stat.size === 0) {
					return {
						content: [{ type: "text", text: `Error: ${filePath} is empty (0 bytes)` }],
						details: { error: "empty_file" },
					};
				}
			} catch {
				return {
					content: [{ type: "text", text: `Error: File not found: ${filePath}` }],
					details: { error: "not_found" },
				};
			}

			// 读取文件内容用于内联返回（确保文件可读且完整）
			let fileContent: string;
			try {
				fileContent = await fs.readFile(filePath, "utf-8");
			} catch {
				return {
					content: [{ type: "text", text: `Error: Cannot read file: ${filePath}` }],
					details: { error: "read_error" },
				};
			}

			// 返回文件内容内联到对话中，前端可直接展示
			// 同时附带 filePath 供 FileDownloadCard 下载
			const desc = params.description ? `\n${params.description}` : "";
			const ext = path.extname(fileName).toLowerCase();
			const lang = ext === ".sql" ? "sql" : ext === ".md" ? "markdown" : "";
			const text = `文件已生成：${fileName}${desc}\n\n\`\`\`${lang}\n${fileContent}\n\`\`\``;

			return {
				content: [{ type: "text", text }],
				details: {
					filePath,
					fileName,
					fileSize: fileContent.length,
					description: params.description,
				},
			};
		},
	});
}
