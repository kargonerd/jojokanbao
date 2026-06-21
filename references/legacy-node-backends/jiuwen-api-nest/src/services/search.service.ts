import { Injectable } from '@nestjs/common';
import { search, SafeSearchType } from 'duck-duck-scrape';
import * as cheerio from 'cheerio';

@Injectable()
export class SearchService {
  async fetchArticleContent(url: string): Promise<string> {
    try {
      const response = await fetch(url);
      const html = await response.text();
      const $ = cheerio.load(html);
      
      // Basic extraction: grab paragraphs. NYT might have specific selectors, but p is safe.
      let text = '';
      $('p').each((i, el) => {
        text += $(el).text() + '\n';
      });
      return text.trim().slice(0, 2000); // Limit to avoid massive tokens
    } catch (e) {
      console.error(`Failed to fetch ${url}`, e);
      return '';
    }
  }

  async performSearch(query: string) {
    console.log(`[SearchService] Executing search for: "${query}"`);
    try {
      const results = await search(query, {
        safeSearch: SafeSearchType.MODERATE,
      });
      
      return results.results.slice(0, 5).map(r => ({
        title: r.title,
        url: r.url,
        description: r.description
      }));
    } catch (error) {
      console.error('Search failed:', error);
      return [];
    }
  }
}
