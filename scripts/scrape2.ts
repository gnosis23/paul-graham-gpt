import { PGChunk, PGEssay, PGJSON } from "@/types";
import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";
import { encode } from "gpt-3-encoder";

const BASE_URL = "https://www.ruanyifeng.com/blog/industry/";
const CHUNK_SIZE = 800;
const DELIMITER_CN = "。";

const getLinks = async () => {
  const html = await axios.get(`${BASE_URL}`);
  const $ = cheerio.load(html.data);
  const links = $("#alpha .module-list-item");

  const linksArr: { url: string; title: string }[] = [];

  links.each((i, item) => {
    const links = $(item).find("a");
    links.each((i, link) => {
      const url = $(link).attr("href");
      const title = $(link).text();

      if (url && url.endsWith(".html")) {
        const linkObj = {
          url,
          title
        };

        linksArr.push(linkObj);
      }
    });
  });

  return linksArr;
};

const getEssay = async (linkObj: { url: string; title: string }) => {
  const { title, url } = linkObj;

  let essay: PGEssay = {
    title: "",
    url: "",
    date: "",
    thanks: "",
    content: "",
    length: 0,
    tokens: 0,
    chunks: []
  };

  const fullLink = url;
  const html = await axios.get(fullLink);
  const $ = cheerio.load(html.data);
  const article = $("article");

  article.each((i, item) => {
    const text = $(item).text();

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
      title,
      url: fullLink,
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

(async () => {
  const links = await getLinks();

  let essays = [];

  for (let i = 0; i < 5; i++) {
    const essay = await getEssay(links[i]);
    const chunkedEssay = await chunkEssay(essay);
    essays.push(chunkedEssay);
  }

  const json: PGJSON = {
    current_date: "2023-04-27",
    author: "ruanyifeng",
    url: "https://www.ruanyifeng.com/blog/industry/",
    length: essays.reduce((acc, essay) => acc + essay.length, 0),
    tokens: essays.reduce((acc, essay) => acc + essay.tokens, 0),
    essays
  };

  fs.writeFileSync("scripts/ruan.json", JSON.stringify(json));
})();
