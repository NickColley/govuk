import EventEmitter from "eventemitter3";
import fetch from "node-fetch";
import retry from "async-retry";
import debug from "debug";
import throttledQueue from "throttled-queue";

// https://dataingovernment.blog.gov.uk/2016/05/26/use-the-search-api-to-get-useful-information-about-gov-uk-content/
// https://docs.publishing.service.gov.uk/repos/search-api/using-the-search-api.html
// Search API doesnt seem to have a rate limit, so do something sensible.
// Global throttle between instances, to avoid multiple clients from sending too many requests.
const requestsPerInterval = 10;
const secondsBetweenIntervals = 1;
const throttle = throttledQueue(
  requestsPerInterval,
  secondsBetweenIntervals * 1000,
  true
);

const getStartValues = (total, count) => {
  if (!total || !count) {
    return [];
  }
  // Figure out how many times we need to hit the API.
  const iterationsNeeded = Math.ceil(total / count);
  // Fill an array with where we need to start from each time we hit it.
  // Allows us to query async
  return Array(iterationsNeeded)
    .fill(0)
    .map((_, index) => index * count);
};

const MAX_PER_PAGE = 1000;

export default class SearchAPI extends EventEmitter {
  constructor() {
    super();
    const { q, ...options } = this.#parseArguments(...arguments);
    this.defaultQuery = q;
    this.defaultOptions = options;
    if (this.defaultQuery) {
      debug("govuk:search")("Default search query:");
      debug("govuk:search")(this.defaultQuery);
    }
    if (this.defaultOptions) {
      debug("govuk:search")("Default search options:");
      debug("govuk:search")(this.defaultOptions);
    }
  }

  #parseArguments(queryOrOptions, maybeOptions) {
    let options = {};
    // ("Register to vote", { count: 2 }) => query: "Register to vote", options: { count: 2 }
    if (typeof queryOrOptions === "string") {
      options = maybeOptions || {};
      options.q = queryOrOptions;
    }

    // ({ q: "Register to vote", count: 2 }) => query: "Register to vote", options: { count: 2 }
    if (typeof queryOrOptions === "object") {
      options = queryOrOptions;
    }

    if (
      typeof options.q === "undefined" &&
      typeof this.defaultQuery !== "undefined"
    ) {
      options.q = this.defaultQuery;
    }

    return {
      ...this.defaultOptions,
      ...options,
    };
  }

  async #get(options) {
    debug("govuk:search:get")("Search options:");
    debug("govuk:search:get")(options);
    if (Object.keys(options).length === 0) {
      throw new Error("No search query");
    }

    const { q, count, start, order, fields, ...otherOptions } = options;

    const baseUrl = new URL("https://www.gov.uk/api/search.json");
    const params = new URLSearchParams();
    if (q) {
      params.append("q", q);
    }
    // https://docs.publishing.service.gov.uk/repos/search-api/using-the-search-api.html#pagination
    if (count) {
      params.append("count", count);
    }
    if (start) {
      params.append("start", start);
    }
    if (order) {
      params.append("order", order);
    }
    // https://github.com/alphagov/search-api/blob/main/config/schema/field_definitions.json
    if (fields) {
      if (!(fields instanceof Array)) {
        throw new Error("Fields parameter must be an array");
      }
      fields.forEach((field) => {
        params.append("fields", field);
      });
    }
    // https://docs.publishing.service.gov.uk/repos/search-api/using-the-search-api.html#using-faceted-search-parameters
    Object.keys(otherOptions).forEach((key) => {
      if (
        key.startsWith("filter_") ||
        key.startsWith("reject_") ||
        key.startsWith("aggregate_")
      ) {
        params.append(key, otherOptions[key]);
      }
    });
    baseUrl.search = params;
    // Sometimes GOV.UK Apis can be flakey when they're cold so retry if they fail.
    return throttle(() =>
      retry(async () => {
        debug("govuk:search:get")("Getting search item:", String(baseUrl));
        const response = await fetch(baseUrl);
        return response.json();
      })
    );
  }

  async getAll() {
    const { count, total, ...options } = this.#parseArguments(...arguments);

    const perPage = typeof count === "undefined" ? MAX_PER_PAGE : count;
    debug("govuk:search:getAll")("Search options:");
    debug("govuk:search:getAll")(options);
    if (Object.keys(options).length === 0) {
      throw new Error("No search query");
    }
    debug("govuk:search:getAll")("Getting total results...");
    const actualTotal = total || (await this.total(options));
    const startValues = getStartValues(actualTotal, perPage);
    debug("govuk:search:getAll")(`Total results found: ${total}`);
    debug("govuk:search:getAll")(`Per page: "${perPage}"`);
    debug("govuk:search:getAll")(
      `Paginate using ${startValues.length} request(s)`
    );
    // Paginate over results...
    const results = await Promise.all(
      startValues.map((start) =>
        this.get({
          ...options,
          count: perPage,
          start,
        })
      )
    );
    return results.flat();
  }

  async total() {
    const options = this.#parseArguments(...arguments);
    const response = await this.#get({
      ...options,
      count: 0,
    });
    return response.total || undefined;
  }

  async get() {
    const options = this.#parseArguments(...arguments);
    const response = await this.#get(options);
    const results = response.results || [];
    this.emit("data", results);
    return results;
  }
}