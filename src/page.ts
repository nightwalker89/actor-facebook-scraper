import Apify from 'apify';
import type { Page, Response } from 'puppeteer';
import DelayAbort, { AbortError } from 'delayable-idle-abort-promise';
import * as escapeRegex from 'escape-string-regexp';
import get = require('lodash.get');
import type { FbPageInfo, FbPost, FbPage, FbGraphQl, FbComment, FbCommentsMode, FbReview, FbService } from './definitions';
import {
    deferred,
    pageSelectors,
    uniqueNonEmptyArray,
    imageSelectors,
    scrollUntil,
    clickSeeMore,
    cutOffDate,
    convertDate,
    stopwatch,
    storyFbToDesktopPermalink,
} from './functions';
import { CSS_SELECTORS, DESKTOP_ADDRESS, LABELS } from './constants';
import { InfoError } from './error';

const { log, sleep } = Apify.utils;

/**
 * Gets information on the main page, that doesn't require interaction
 *
 * @throws {InfoError}
 */
export const getPageInfo = async (page: Page): Promise<FbPageInfo> => {
    const [
        title,
        messenger,
        verified,
        ld,
    ] = await Promise.allSettled([
        page.$eval(CSS_SELECTORS.PAGE_NAME, async (el) => {
            if (el && el.attributes) {
                window.unhideChildren(el as HTMLMetaElement);

                const content = el.attributes.getNamedItem('content') as HTMLMetaElement | null;

                if (content?.textContent) {
                    return `${content.textContent}`;
                }
            }

            return '';
        }),
        pageSelectors.messenger(page, 1000),
        pageSelectors.verified(page, 1000),
        pageSelectors.ld(page, 1000),
    ]);

    const titleValue = title.status === 'fulfilled' ? title.value : '';

    // this is a best effort attempt to get the like count. starting from 1 million+,
    // things get wild and unprecise
    const likes = await page.$eval(CSS_SELECTORS.META_DESCRIPTION, async (el, pageTitle) => {
        let text = '';

        if (el && el.attributes) {
            window.unhideChildren(el as HTMLMetaElement);

            const content = el.attributes.getNamedItem('content') as HTMLMetaElement | null;

            if (content?.textContent) {
                text = `${content.textContent}`;
            }
        }

        const likesNumber = text
            .replace(pageTitle, '')
            .replace(/^[^\d]+/, '') // like count starts after the page name
            .match(/([\s,.0-9]+)\s?([mk]{0,1})/i); // number format varies depending on language, like 1,200, 1 200, 1.200, 1.2K, 2M

        if (likesNumber?.[1]) {
            const trimmed = likesNumber[1].trim();
            const parsedNumber = trimmed.length < 5 ? trimmed.replace(/,/g, '.') : trimmed; // 1,2 -> 1.2, 1.2 -> 1.2, 1200 -> 1200
            let value = +(parsedNumber.replace(/[^.0-9]/g, '')) || 0;
            let multipler = 1;

            if (likesNumber?.[2]) {
                if (/^m$/i.test(likesNumber[2])) {
                    multipler = 1000000;
                } else if (/^k$/i.test(likesNumber[2])) {
                    multipler = 1000;
                }
            } else if (!Number.isInteger(value)) {
                value = +(`${value}`.replace(/[^0-9]/g, ''));
            }

            return value * multipler;
        }

        return 0;
    }, titleValue);

    const info = ld.status === 'fulfilled' ? (ld.value?.[0]?.address ?? null) : null;

    return {
        verified: verified.status === 'fulfilled' ? verified.value : false,
        title: titleValue,
        messenger: messenger.status === 'fulfilled' ? messenger.value : '',
        likes,
        city: info?.addressLocality ?? null,
        postalCode: info?.postalCode ?? null,
        region: info?.addressRegion ?? null,
        street: info?.streetAddress ?? null,
    };
};

/**
 * Get the pages listing, removing
 * duplicates if any
 */
export const getPagesFromListing = async (page: Page) => {
    return new Set<string>(
        await page.$$eval('div > a[href][onmousedown*="click_page_link"]', async (links) => {
            // returns the desktop version of the link, like https://www.facebook.com/somepage?ref...
            return (links as HTMLAnchorElement[]).map(s => s.href);
        }),
    );
};

/**
 * Get posts until it reaches the given max
 */
export const getPostUrls = async (page: Page, {
    max, date, minDate, username, requestQueue,
}: {
    requestQueue: Apify.RequestQueue,
    username: string;
    max?: number;
    date?: number | null,
    minDate?: number | null,
}) => {
    if (!max) {
        return [];
    }

    const urls = new Set<string>();
    const finish = deferred(); // gracefully finish
    const currentUrl = page.url();

    const postCutOffDate = cutOffDate(date);
    const minPostCutOffDate = cutOffDate(minDate, true);
    const start = stopwatch();
    const control = DelayAbort(30000);
    const scrollingSleep = 200;
    let olderCount = 0;

    const getPosts = async () => {
        try {
            const posts = await pageSelectors.posts(page, scrollingSleep);

            for (const { isPinned, publishedTime, url } of posts) {
                log.debug('Post info', {
                    isPinned,
                    publishedTime,
                    url,
                });

                control.postpone();

                if (max && (urls.size >= max || olderCount > Math.ceil(urls.size / 1.04))) {
                    log.info('Stopping getting posts', { olderCount, size: urls.size, threshold: Math.ceil(urls.size / 1.04) });

                    finish.resolve();
                    return;
                }

                if (!minPostCutOffDate(publishedTime) && !isPinned) {
                    log.debug('No min cut off date', { publishedTime, url });
                    continue; // eslint-disable-line no-continue
                }

                const isNewer = postCutOffDate(publishedTime);

                if (!isNewer) {
                    log.debug('Is older', { publishedTime, url });
                    olderCount++;
                }

                const parsed = storyFbToDesktopPermalink(url);

                if (isNewer && parsed && !urls.has(parsed.toString())) {
                    urls.add(parsed.toString());

                    const story_fbid = parsed.searchParams.get('story_fbid');

                    await requestQueue.addRequest({
                        url: parsed.href,
                        userData: {
                            label: LABELS.POST,
                            useMobile: false,
                            username,
                            canonical: `${DESKTOP_ADDRESS}/${username}/${story_fbid
                                ? `posts/${story_fbid}`
                                : parsed.pathname.split(/\/(photos|videos)\//).slice(1).join('/')
                            }`,
                        },
                    });
                }
            }
        } catch (e) {
            log.debug(`getPosts: ${e.message}`, {
                ids: [...urls],
            });

            finish.resolve();
        }

        await sleep(scrollingSleep);

        try {
            await page.click('a[ajaxify^="/pages_reaction_units/more/"]', { delay: scrollingSleep });
            log.debug('Clicking see more', { currentUrl });
        } catch (e) {
            log.debug(`More click`, { e: e.message, currentUrl });
        }
    };

    const interceptAjax = async (res: Response) => {
        if (res.url().includes('page_content_list_view/more')) {
            control.postpone(); // we are getting new posts
        }

        const status = res.status();

        if (status !== 200 && status !== 302) {
            log.debug('Res status', { status });
            finish.resolve();
        }
    };

    page.on('response', interceptAjax);

    try {
        await getPosts();

        await control.run([
            finish.promise,
            scrollUntil(page, {
                sleepMillis: scrollingSleep,
                maybeStop: async ({ count, bodyChanged, scrollChanged }) => {
                    await getPosts();

                    log.debug(`Current size ${urls.size} of ${max}`, { count, bodyChanged, scrollChanged });

                    return urls.size >= max || (count > 100 && !bodyChanged && !scrollChanged);
                },
            }),
        ]);
    } catch (e) {
        if (e instanceof AbortError) {
            log.warning(`Loading of posts aborted`, { url: currentUrl, username });
        } else {
            throw e;
        }
    } finally {
        log.debug('Cleanup', { url: currentUrl, username });
        finish.resolve();
        page.off('response', interceptAjax);
    }

    log.info(`Got ${urls.size} posts in ${start() / 1000}s`, { username, url: currentUrl });
};

/**
 * Get the reviews until it reaches the given max
 */
export const getReviews = async (
    page: Page,
    {
        date,
        max,
    }: {
        max?: number;
        date?: number | null;
    },
): Promise<FbPage['reviews'] | undefined> => {
    if (!max) {
        return;
    }

    const ld = await pageSelectors.ld(page);
    const reviews = new Map<string, FbReview>();
    const reviewDateCutOff = cutOffDate(date);
    const finish = deferred(); // gracefully finish
    const currentUrl = page.url();
    const start = stopwatch();
    const control = DelayAbort(30000);

    const getReviewsFromPage = async () => {
        for (const review of await pageSelectors.reviews(page, 1000)) {
            if (review.url && !reviews.has(review.url)) {
                control.postpone();
                reviews.set(review.url, review);
            }

            if (reviews.size >= max) {
                finish.resolve();
                break;
            }
        }

        await sleep(500);
    };

    const interceptAjax = async (res: Response) => {
        if (res.url().includes('page_content_list_view/more')) {
            control.postpone(); // we are getting new posts
        }

        const status = res.status();

        if (status !== 200 && status !== 302) {
            log.debug('Res status', { status });
            finish.resolve();
        }
    };

    page.on('response', interceptAjax);

    await getReviewsFromPage();

    try {
        await control.run([
            finish.promise,
            scrollUntil(page, {
                sleepMillis: 500,
                maybeStop: async ({ scrollChanged, count, bodyChanged }) => {
                    await getReviewsFromPage();

                    return reviews.size >= max || (count > 2 && !scrollChanged && !bodyChanged);
                },
            }),
        ]);
    } catch (e) {
        if (e instanceof AbortError) {
            log.warning('Loading of reviews aborted', { url: currentUrl });
        } else {
            throw e;
        }
    } finally {
        finish.resolve();
        page.off('response', interceptAjax);
    }

    const processedReviews = [...reviews.values()].filter((s) => reviewDateCutOff(s.date)).map((s) => {
        if (s.url && s.url.includes('story_fbid')) {
            const parsed = storyFbToDesktopPermalink(s.url);

            return {
                ...s,
                url: parsed?.href ?? null,
                canonical: s.url,
            };
        }

        return {
            ...s,
            canonical: null,
        };
    });

    log.info(`Got ${processedReviews.length} reviews in ${start() / 1000}s`, {
        url: currentUrl,
    });

    return {
        average: ld?.[0]?.aggregateRating?.ratingValue ?? null,
        reviews: processedReviews,
        count: ld?.[0]?.aggregateRating?.ratingCount ?? null,
    };
};

/**
 * Try to get the information on pages that might have,
 * appending to the existing crawl state
 *
 * Some keys have a different behavior, so they need to be dealt
 * with separately
 */
export const getFieldInfos = async (page: Page, currentState: Partial<FbPage>): Promise<Partial<FbPage>> => {
    const url = page.url();

    try {
        await page.waitForFunction(() => {
            return !document.querySelector('#pages_msite_body_contents img[src^="data"]');
        }, {
            polling: 300,
            timeout: 15000,
        });
    } catch (e) {
        throw new InfoError('Profile isn\'t loading the images, will be retried', {
            namespace: 'getFieldInfos',
            selector: 'img[src^="data"]',
            url,
        });
    }

    const selectorKeys = Object.keys(imageSelectors) as Array<keyof typeof imageSelectors>;

    await scrollUntil(page, {
        sleepMillis: 300,
        maybeStop: async ({ count }) => {
            return count > 5;
        },
        selectors: [
            CSS_SELECTORS.SEE_MORE,
            CSS_SELECTORS.PAGE_TRANSPARENCY,
            'article', // posts loaded, usually past about box
        ],
    });

    await clickSeeMore(page);

    // execute all selectors in parallel and in
    // the expected keys order
    const result = await Promise.allSettled(
        selectorKeys.map(key => imageSelectors[key](page)),
    ).then((r) => {
        return r.map((v) => {
            if (v.status === 'rejected') {
                log.debug(v.reason.message, v.reason.toJSON());
            }

            return v.status === 'fulfilled' ? v.value : [];
        });
    });

    // match the results with the selectors name, to generate
    // the output object. existing non-empty entries won't be
    // overwritten.
    //
    // we need to fallback to null because undefined is removed
    // from JSON.stringify
    const fieldsInfo: Partial<FbPage> = selectorKeys.reduce((out, key, index) => {
        switch (key) {
            case 'categories':
                out[key] = uniqueNonEmptyArray((out[key] || [])
                    .concat(result[index].map(s => s.split(' · ')).flat())) || null;
                break;
            case 'priceRange':
                out[key] = out[key] || (result[index]
                    .map(s => (s.split(' · ', 2)[1])) // $ · $$$
                    .filter(s => s))[0] || null;
                break;
            case 'address':
                out[key] = {
                    city: out[key]?.city ?? null,
                    lat: out[key]?.lat ?? null,
                    lng: out[key]?.lng ?? null,
                    postalCode: out[key]?.postalCode ?? null,
                    region: out[key]?.region ?? null,
                    street: out[key]?.street ?? null,
                };
                break;
            case 'info':
                // info can contain things like "founded", "about", etc
                out[key] = uniqueNonEmptyArray((out[key] || []).concat(result[index])) || null;
                break;
            // array of items to one item, usually from multiple sources, like main -> about
            case 'website':
            case 'email':
            case 'phone':
            case 'transit':
            case 'instagram':
            case 'twitter':
            case 'payment':
            case 'youtube':
            case 'checkins':
                out[key] = out[key] || uniqueNonEmptyArray(result[index])[0] || null;
                break;
            default:
                // arrays
                out[key] = uniqueNonEmptyArray((out[key] || []).concat(result[index].join('\n')));
        }

        return out;
    }, currentState);

    // some sanity check for info that should always be available, both in 'home' and about 'pages'
    if (!fieldsInfo.categories || !fieldsInfo.categories.length) {
        throw new InfoError('Missing categories, most likely wrong mobile layout. This will be retried', {
            namespace: 'getFieldInfos',
            url,
        });
    }

    return {
        ...fieldsInfo,
        address: {
            ...fieldsInfo.address!,
            ...await pageSelectors.latLng(page),
        },
    };
};

/**
 * Detects if the current page is a "not found" page (big thumb)
 */
export const isNotFoundPage = async (page: Page) => {
    // real pages have og:url meta
    return !(await page.$(CSS_SELECTORS.VALID_PAGE));
};

/**
 * A couple of regex operations on the post page, that contains
 * statistics about the post itself
 */
export const getPostInfoFromScript = async (page: Page, url: string) => {
    // fetch "timeslice" scripts, don't want related posts
    const html = await page.$$eval('script', async (script, postUrl) => {
        const r = new RegExp(postUrl, 'i');

        return script.filter((s) => {
            return r.test(s.innerHTML);
        }).map((s) => s.innerHTML).join('\n');
    }, escapeRegex(`url:"${url}`));

    const commentsMatch = html.matchAll(/comment_count:{total_count:(\d+)/g);
    const reactionsMatch = html.matchAll(/reaction_count:{count:(\d+)/g);
    const shareMatch = html.matchAll(/share_count:{count:(\d+)/g);

    const maxFromMatches = (matches: IterableIterator<RegExpMatchArray>) => [...matches]
        .reduce((count, [, value]) => (+value > count ? +value : count), 0);

    const reactionsBreakdown = (() => {
        try {
            return eval(`${html.split('top_reactions:{edges:')?.[1].split('}]}')?.[0]}}]`) as any[]; // eslint-disable-line no-eval
        } catch (e) {
            return [];
        }
    })();

    return {
        comments: maxFromMatches(commentsMatch),
        reactions: maxFromMatches(reactionsMatch),
        reactionsBreakdown: reactionsBreakdown.reduce((out, node) => {
            out[`${get(node, ['node', 'reaction_type'], '')}`.toLowerCase()] = node.reaction_count;
            return out;
        }, {}),
        shares: maxFromMatches(shareMatch),
    };
};

/**
 * Get the content from the dedicated post page.
 *
 * Throwing here will propagate to the main error handler,
 * which we are already expecting
 */
export const getPostContent = async (page: Page): Promise<Partial<FbPost>> => {
    const content = await page.$eval(CSS_SELECTORS.POST_CONTAINER, async (el): Promise<Partial<FbPost>> => {
        const postDate = (el.querySelector('[data-utime]') as HTMLDivElement)?.dataset?.utime;
        const userContent = el.querySelector('.userContent') as HTMLDivElement;

        if (!userContent) {
            throw new Error('Missing .userContent');
        }

        window.unhideChildren(userContent);

        const postText = userContent.innerText.trim();
        const images: HTMLImageElement[] = Array.from(el.querySelectorAll('img[src*="scontent"]'));
        const links: HTMLAnchorElement[] = Array.from(el.querySelectorAll('[href*="l.facebook.com/l.php?u="]'));

        return {
            postDate,
            postText,
            postImages: images.filter(img => img.closest('a[rel="theater"]') && img.src).map((img) => {
                return {
                    link: img.closest<HTMLAnchorElement>('a[rel="theater"]')!.href,
                    image: img.src,
                };
            }),
            postLinks: [...new Set(links.filter(link => link.href).map((link) => {
                try {
                    const url = new URL(link.href);

                    return url.searchParams.get('u') || '';
                } catch (e) {
                    return '';
                }
            }).filter(s => s))],
        };
    });

    return {
        ...content,
        postDate: convertDate(content.postDate, true),
        postUrl: page.url(),
    };
};

/**
 * Interact with the page to the the comments
 */
export const getPostComments = async (
    page: Page,
    {
        max,
        date,
        mode = 'RANKED_THREADED',
    }: {
        max?: number;
        date?: number | null;
        mode?: FbCommentsMode;
    },
): Promise<FbPost['postComments']> => {
    const comments = new Map<string, FbComment>();

    const finish = deferred(); // gracefully finish
    const currentUrl = page.url();
    const start = stopwatch();
    const commentCutOffDate = cutOffDate(date);

    const control = DelayAbort(30000);
    let count = 0;
    let canStartAdding = false;
    let olderCount = 0;

    if (max) {
        log.debug('Starting loading comments', { url: currentUrl, mode, max });

        const interceptGrapQL = async (res: Response) => {
            if (res.url().includes('api/graphql/') && canStartAdding) {
                let json: FbGraphQl | null = null;

                try {
                    json = await res.json() as FbGraphQl;
                } catch (e) {
                    log.debug(`res.json ${e.message}`, { url: res.url() });
                }

                if (json) {
                    const data = get(json, ['data', 'feedback', 'display_comments']);

                    if (data) {
                        if (data.count > count) {
                            count = data.count; // eslint-disable-line prefer-destructuring
                        }

                        if (data.edges?.length > 0) {
                            control.postpone(); // postpone abort only if there are comments available

                            data.edges.map((s) => s.node).filter(s => s).forEach((p) => {
                                if (!comments.has(p.id)) {
                                    if (comments.size >= max) {
                                        return;
                                    }

                                    if (!commentCutOffDate(p.created_time)) {
                                        olderCount++;
                                    }

                                    comments.set(p.id, {
                                        date: convertDate(p.created_time, true),
                                        name: get(p, ['author', 'name']),
                                        profileUrl: get(p, ['author', 'url']) || null,
                                        profilePicture: get(
                                            p,
                                            ['author', 'profile_picture_depth_0', 'uri'],
                                            get(p, ['author', 'profile_picture_depth_1_legacy', 'uri']),
                                        ) || null,
                                        text: get(p, ['body', 'text']) || null,
                                        url: p.url,
                                    });
                                }
                            });
                        }

                        const hasNext = get(data, ['page_info', 'has_next_page']);

                        if (hasNext === false || comments.size >= max || olderCount > Math.ceil(comments.size / 1.04)) {
                            log.debug('Posts comments', { hasNext, size: comments.size, olderCount, threshold: Math.ceil(comments.size / 1.04) });
                            finish.resolve();
                        }
                    }
                }
            }

            const status = res.status();

            if (status !== 200 && status !== 302) {
                log.debug('Res status', { status });
                finish.resolve();
            }
        };

        page.on('response', interceptGrapQL);

        try {
            log.debug('Trying to click load comments');

            if (mode === 'RANKED_UNFILTERED' || mode === 'RANKED_THREADED') {
                canStartAdding = true;
            }

            // clicking stuff is brute-force, until it works
            const loadCommentsClicked = await page.evaluate(async ({ load, container, commentOrder }) => {
                let tries = 0;

                return new Promise<boolean>((resolve) => {
                    const tryLoad = () => {
                        const loadComments = document.querySelector<HTMLAnchorElement>(load);

                        if (document.querySelector(container) || document.querySelector(commentOrder)) {
                            resolve(true);
                        } else if (!loadComments) {
                            tries++;
                        } else {
                            tries++;
                            loadComments.click();
                        }

                        if (tries < 10) {
                            setTimeout(tryLoad, tries * 200);
                        } else {
                            resolve(false);
                        }
                    };

                    setTimeout(tryLoad, 700);
                });
            }, {
                load: CSS_SELECTORS.LOAD_COMMENTS,
                container: CSS_SELECTORS.COMMENTS_CONTAINER,
                commentOrder: CSS_SELECTORS.COMMENT_ORDER,
            });

            if (loadCommentsClicked) {
                log.debug('Load comments clicked, waiting more', { url: currentUrl, mode });

                try {
                    await page.waitForSelector(CSS_SELECTORS.COMMENT_ORDER, {
                        timeout: 5000,
                        visible: true,
                    });
                } catch (e) {
                    log.debug('No more comments');
                }

                control.postpone();

                if (mode !== 'RANKED_THREADED') {
                    const commentOrdering = await page.$$eval(CSS_SELECTORS.COMMENT_ORDER, async (els) => {
                        if (!els.length) {
                            return false;
                        }

                        (els as HTMLAnchorElement[]).forEach((el) => {
                            el.click();
                        });

                        return true;
                    });

                    if (commentOrdering) {
                        log.debug('Opened comment ordering', { url: currentUrl });

                        try {
                            await page.waitForSelector('[role="menuitemcheckbox"]', {
                                timeout: 15000,
                            });
                        } catch (e) {
                            log.debug(e.message, { url: currentUrl });
                        }

                        canStartAdding = true;

                        await page.$$eval('[role="menuitemcheckbox"]', async (els, commentMode) => {
                            (els as HTMLAnchorElement[]).filter((s) => s.querySelector(`[data-ordering="${commentMode}"]`)).forEach((el) => {
                                const target = el.querySelector<HTMLDivElement>('[data-ordering]');

                                if (target) {
                                    target.click();
                                }
                            });
                        }, mode);

                        log.debug('Changed mode', { url: currentUrl });

                        try {
                            await page.waitForSelector(CSS_SELECTORS.LOAD_MORE_COMMENTS, {
                                timeout: 5000,
                                visible: true,
                            });
                        } catch (e) {
                            log.debug(e.message, { url: currentUrl });
                        }
                    } else {
                        canStartAdding = true;

                        log.warning(`Comment ordering not found, using default "Most relevant"`, {
                            url: currentUrl,
                        });
                    }
                } else {
                    canStartAdding = true;
                }

                let clickTries = 0;

                await control.run([
                    finish.promise,
                    scrollUntil(page, {
                        sleepMillis: 500, // 1500 seconds in total
                        maybeStop: async ({ bodyChanged }) => {
                            const clicked = await page.$$eval(CSS_SELECTORS.LOAD_MORE_COMMENTS, async (els) => {
                                let clicks = 0;

                                (els as HTMLAnchorElement[]).filter(s => !s.querySelector('i') && !s.closest('ul')).forEach((el) => {
                                    el.click();
                                    clicks++;
                                });

                                return clicks;
                            });

                            if (!clicked) {
                                clickTries++;
                            }

                            await sleep(500);

                            log.debug('Current clicks on scrollUntil', { url: currentUrl, clicked, clickTries });

                            if (!bodyChanged && clickTries > 3) {
                                return true;
                            }

                            await page.evaluate(() => {
                                document.querySelectorAll('h6.accessible_elem ~ ul > li').forEach(s => s.remove());
                            });

                            return max ? comments.size >= max : false;
                        },
                    }),
                ]);
            } else {
                log.debug('Load comment button not found', { url: currentUrl });
            }
        } catch (e) {
            if (e instanceof AbortError) {
                log.warning('Loading of new comments aborted', { url: currentUrl });
            } else {
                throw e;
            }
        } finally {
            page.off('response', interceptGrapQL);
            finish.resolve();
        }
    }

    const processedComments = [...comments.values()]
        .filter((s) => commentCutOffDate(s.date));

    log.info(`Got ${processedComments.length} comments in ${start() / 1000}s`, { url: currentUrl });

    return {
        count,
        mode,
        comments: processedComments,
    };
};

/**
 * Get /services. Return early if /services is the home page
 */
export const getServices = async (page: Page): Promise<FbService[]> => {
    const sleepMillis = 300;

    await scrollUntil(page, {
        sleepMillis,
        maybeStop: async ({ count, bodyChanged, scrollChanged }) => {
            await sleep(sleepMillis);

            return (count > 2 && !bodyChanged && !scrollChanged) || !(await page.$(CSS_SELECTORS.SERVICES));
        },
    });

    return (await page.$$eval<FbService[]>(CSS_SELECTORS.SERVICES, (els) => {
        return els.map((el) => {
            const text = el.querySelector<HTMLSpanElement>('div > span');

            window.unhideChildren(text);

            return {
                title: el.querySelector('div > h3')?.textContent ?? null,
                text: text?.innerText ?? null,
            };
        });
    })).filter((s) => s.text !== null && s.title !== null);
};
