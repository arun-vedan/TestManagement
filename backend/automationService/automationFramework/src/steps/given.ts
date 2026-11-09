import { Given } from '@cucumber/cucumber';
import { setAPIEndPoint } from '../support/api/setAPIEndPoint.js';
import checkContainsAnyText from '../support/check/checkContainsAnyText.js';
import checkIsEmpty from '../support/check/checkIsEmpty.js';
import checkContainsText from '../support/check/checkContainsText.js';
import checkCookieContent from '../support/check/checkCookieContent.js';
import checkCookieExists from '../support/check/checkCookieExists.js';
import checkDimension from '../support/check/checkDimension.js';
import checkElementExists from '../support/check/checkElementExists.js';
import checkEqualsText from '../support/check/checkEqualsText.js';
import checkModal from '../support/check/checkModal.js';
import checkOffset from '../support/check/checkOffset.js';
import checkProperty from '../support/check/checkProperty.js';
import checkSelected from '../support/check/checkSelected.js';
import checkTitle from '../support/check/checkTitle.js';
import checkUrl from '../support/check/checkURL.js';
import closeAllButFirstTab from '../support/action/closeAllButFirstTab.js';
import compareText from '../support/check/compareText.js';
import isEnabled from '../support/check/isEnabled.js';
import isDisplayed from '../support/check/isDisplayed.js';
import openWebsite from '../support/action/openWebsite.js';
import setWindowSize from '../support/action/setWindowSize.js';

// Step Definitions using Cucumber Expressions

Given('I open the {word} {string}', openWebsite);

Given('url {string}', setAPIEndPoint);

Given('the element {string} is[ not] displayed', isDisplayed);

Given('the element {string} is[ not] enabled', isEnabled);

Given('the element {string} is[ not] selected', checkSelected);

Given('the checkbox {string} is[ not] checked', checkSelected);

Given('there is {word} element {string} on the page', checkElementExists);

Given('the title is[ not] {string}', checkTitle);

Given('the element {string} contains[ not] the same text as element {string}', compareText);

Given('the {word} {string}[ not] matches the text {string}', checkEqualsText);

Given('the {word} {string}[ not] contains the text {string}', checkContainsText);

Given('the {word} {string}[ not] contains any text', checkContainsAnyText);

Given('the {word} {string} is[ not] empty', checkIsEmpty);

Given('the page url is[ not] {string}', checkUrl);

Given('the{word} attribute {string} from element {string} is[ not] {string}', checkProperty);

Given('the cookie {string} contains[ not] the value {string}', checkCookieContent);

Given('the cookie {string} does[ not] exist', checkCookieExists);

Given('the element {string} is[ not] {int}px {word}', checkDimension);

Given('the element {string} is[ not] positioned at {int}px on the {word} axis', checkOffset);

Given('I have a screen that is {int} by {int} pixels', setWindowSize);

Given('I have closed all but the first {word}', closeAllButFirstTab as never);

Given('a {word} is[ not] opened', checkModal);
