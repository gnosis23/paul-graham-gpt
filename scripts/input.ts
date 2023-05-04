import { PGChunk, PGEssay } from "@/types";
import fs from "fs";
import { encode } from "gpt-3-encoder";
import { loadEnvConfig } from "@next/env";
import { createClient } from "@supabase/supabase-js";
import { Configuration, OpenAIApi } from "openai";

loadEnvConfig("");

const CHUNK_SIZE = 200;
const DELIMITER_CN = "。";

const getEssay = async (text: string) => {
	let essay: PGEssay = {
		title: "文本",
		url: "",
		date: "",
		thanks: "",
		content: "",
		length: 0,
		tokens: 0,
		chunks: []
	};

	const article = [text];

	article.forEach((item) => {
		const text = (item);

		let cleanedText = text.replace(/\s+/g, " ");
		cleanedText = cleanedText.replace(/。([a-zA-Z])/g, `${DELIMITER_CN} $1`);

		const date = cleanedText.match(/(\d{4}年\d+月\d+日)/);
		let dateStr = "";
		let textWithoutDate = "";

		if (date) {
			dateStr = date[0];
			textWithoutDate = cleanedText.replace(date[0], "");
		}

		let essayText = textWithoutDate.replace(/\n/g, " ");
		let thanksTo = "";

		const split = essayText.split(DELIMITER_CN + " ").filter((s) => s);
		const lastSentence = split[split.length - 1];

		if (lastSentence && lastSentence.includes("Thanks to")) {
			const thanksToSplit = lastSentence.split("Thanks to");

			if (thanksToSplit[1].trim()[thanksToSplit[1].trim().length - 1] === ".") {
				thanksTo = "Thanks to " + thanksToSplit[1].trim();
			} else {
				thanksTo = "Thanks to " + thanksToSplit[1].trim() + ".";
			}

			essayText = essayText.replace(thanksTo, "");
		}

		const trimmedContent = essayText.trim();

		essay = {
			title: '用户自定义文本',
			url: 'https://bmai.cloud',
			date: dateStr,
			thanks: thanksTo.trim(),
			content: trimmedContent,
			length: trimmedContent.length,
			tokens: encode(trimmedContent).length,
			chunks: []
		};
	});

	return essay;
};

const chunkEssay = async (essay: PGEssay) => {
	const { title, url, date, thanks, content, ...chunklessSection } = essay;

	let essayTextChunks = [];

	if (encode(content).length > CHUNK_SIZE) {
		const split = content.split(DELIMITER_CN + " ");
		let chunkText = "";

		for (let i = 0; i < split.length; i++) {
			const sentence = split[i];
			const sentenceTokenLength = encode(sentence);
			const chunkTextTokenLength = encode(chunkText).length;

			if (chunkTextTokenLength + sentenceTokenLength.length > CHUNK_SIZE) {
				essayTextChunks.push(chunkText);
				chunkText = "";
			}

			if (sentence[sentence.length - 1].match(/[a-z0-9]/i)) {
				chunkText += sentence + DELIMITER_CN + " ";
			} else {
				chunkText += sentence + " ";
			}
		}

		essayTextChunks.push(chunkText.trim());
	} else {
		essayTextChunks.push(content.trim());
	}

	const essayChunks = essayTextChunks.map((text) => {
		const trimmedText = text.trim();

		const chunk: PGChunk = {
			essay_title: title,
			essay_url: url,
			essay_date: date,
			essay_thanks: thanks,
			content: trimmedText,
			content_length: trimmedText.length,
			content_tokens: encode(trimmedText).length,
			embedding: []
		};

		return chunk;
	});

	if (essayChunks.length > 1) {
		for (let i = 0; i < essayChunks.length; i++) {
			const chunk = essayChunks[i];
			const prevChunk = essayChunks[i - 1];

			if (chunk.content_tokens < 100 && prevChunk) {
				prevChunk.content += " " + chunk.content;
				prevChunk.content_length += chunk.content_length;
				prevChunk.content_tokens += chunk.content_tokens;
				essayChunks.splice(i, 1);
				i--;
			}
		}
	}

	const chunkedSection: PGEssay = {
		...essay,
		chunks: essayChunks
	};

	return chunkedSection;
};

const generateEmbeddings = async (essays: PGEssay[]) => {
	const configuration = new Configuration({ apiKey: process.env.OPENAI_API_KEY });
	const openai = new OpenAIApi(configuration);

	const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

	for (let i = 0; i < essays.length; i++) {
		const section = essays[i];

		for (let j = 0; j < section.chunks.length; j++) {
			const chunk = section.chunks[j];

			const { essay_title, essay_url, essay_date, essay_thanks, content, content_length, content_tokens } = chunk;

			const embeddingResponse = await openai.createEmbedding({
				model: "text-embedding-ada-002",
				input: content
			});

			const [{ embedding }] = embeddingResponse.data.data;

			const { data, error } = await supabase
				.from("pg")
				.insert({
					essay_title,
					essay_url,
					essay_date,
					essay_thanks,
					content,
					content_length,
					content_tokens,
					embedding
				})
				.select("*");

			if (error) {
				console.log("error", error);
			} else {
				console.log("saved", i, j);
			}

			await new Promise((resolve) => setTimeout(resolve, 200));
		}
	}
};


(async () => {
	let essays = [];

	const content = fs.readFileSync('scripts/input.txt', 'utf8');
	const essay = await getEssay(content);
	const chunkedEssay = await chunkEssay(essay);
	essays.push(chunkedEssay);

	await generateEmbeddings(essays);
})();
