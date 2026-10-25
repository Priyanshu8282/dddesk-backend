// First-run text for the three public legal pages. It restates how the software behaves (taken from the pages that were
// hard-coded on the website before they became editable) and marks what the owner must still supply.
// It is NOT legal advice: the owner and a lawyer must review it, then publish a new version from the Super Admin panel.
const REVIEW = '<p><strong>To be reviewed by the owner and legal counsel.</strong> This text describes how the service works today. Replace the bracketed items and publish a new version from Super Admin → Legal Pages.</p>';

module.exports = {
    privacy_policy: {
        title: 'Privacy Policy',
        html: `${REVIEW}
<h2>Who is responsible for the data?</h2>
<p>DDdesk is software used by libraries and study rooms. The library that admits a student decides why the student's data is collected and is the data fiduciary for it. DDdesk processes that data on the library's behalf to run the service.</p>
<h2>What data is collected?</h2>
<ul>
<li>Student details: name, mobile number, email, address, date of birth, photo and plan or seat information.</li>
<li>Guardian details for students under 18: name, mobile number, relation and consent.</li>
<li>Identity: for Aadhaar, only the last four digits and a one-way hash used to detect duplicates are stored. An optional image of an identity document can be uploaded.</li>
<li>Usage records: attendance check-ins, fee charges, payments, receipts and refunds.</li>
<li>Staff and owner accounts: name, email, mobile number, role and sign-in activity.</li>
<li>New library sign-up: the mobile number you verify with an OTP, the plan you choose and the library details you enter. These are kept as a draft for up to 7 days until you finish, then removed if you do not.</li>
</ul>
<h2>Which cookies and browser storage do we use?</h2>
<p>Necessary only. A sign-in marker cookie and a secure, HttpOnly session cookie set by our server keep you signed in; your cookie choice is saved for about six months; and your light or dark theme and sign-in profile are saved in your browser's storage. We do not run analytics or advertising cookies today. You can change your choice at any time from "Cookie settings" in the page footer.</p>
<h2>Why is it used?</h2>
<p>To admit students, allocate seats, record attendance, collect fees and issue receipts, send notices and reminders, keep accounts, and protect the service from misuse. Data is not sold.</p>
<h2>How is consent handled?</h2>
<p>Consent is recorded at admission together with the date, the person who recorded it and the version of the privacy notice. For a student under 18, the guardian's details and consent are required.</p>
<h2>How long is data kept?</h2>
<p>Student records stay while the student is a member and for a configurable period after they are archived. Financial records such as payments and receipts may be kept longer for accounting and tax purposes, even after personal details are erased.</p>
<h2>What rights do students and guardians have?</h2>
<ul>
<li>Access: ask the library for a copy of the data held about the student.</li>
<li>Correction: ask the library to fix wrong details.</li>
<li>Erasure: ask the library to erase personal details. The library owner can anonymise the record, while keeping the financial history needed for accounts.</li>
<li>Grievance: raise a complaint with the library first, then with the contact below.</li>
</ul>
<h2>Who else receives data?</h2>
<p>Service providers needed to run the platform, such as hosting, email or SMS delivery and the Razorpay payment gateway, process data only for those purposes.</p>
<h2>How is data protected?</h2>
<p>Access is limited by role and branch, each library sees only its own data, sign-in is protected against repeated guessing, and identity documents are available only to authorised staff after login. No system can promise absolute security.</p>
<h2>Grievance officer and contact</h2>
<p>[Legal entity name], [registered address], [grievance officer name and email], [response time]</p>`,
    },
    terms_and_conditions: {
        title: 'Terms and Conditions',
        html: `${REVIEW}
<h2>Who can use DDdesk?</h2>
<p>Libraries registered on DDdesk (a new library may be reviewed first), and the staff and students those libraries invite. Accounts are personal: keep your password and one-time codes private.</p>
<h2>What are a library's responsibilities?</h2>
<p>The library is responsible for the accuracy of what it enters, for having permission (including guardian consent for minors) to store its students' data, for the fees and taxes it charges its own students, and for the access it gives its staff.</p>
<h2>How do subscriptions and payments work?</h2>
<p>Access continues while the subscription is active. If a subscription lapses there is a grace period and then the library can be suspended until it renews. Payments are processed by Razorpay.</p>
<h2>What is not allowed?</h2>
<p>Attempting to access another library's data, interfering with the service, using it for unlawful purposes or sharing accounts to avoid plan limits.</p>
<h2>Liability and changes</h2>
<p>[Limitation of liability, governing law and jurisdiction, notice period for changes to these terms]</p>`,
    },
    refund_cancellation_policy: {
        title: 'Refund and Cancellation Policy',
        html: `${REVIEW}
<h2>How does the free trial work?</h2>
<p>When a plan includes a free trial, no payment is taken at sign-up. You start on the trial and choose to pay before it ends. The length of each plan's trial is shown on the <a href="/pricing">Pricing</a> page.</p>
<h2>How do I cancel my subscription?</h2>
<p>The library owner can cancel from the Subscription page in the account. A cancelled plan stays active until the end of the period that has been paid for, and is not renewed after that.</p>
<h2>What about refunds for DDdesk subscriptions?</h2>
<p>[State the refund rules for subscription payments here: refund window, what is refundable, how long a refund takes.]</p>
<p>Online payments are processed through Razorpay. GST, where charged, is shown separately on the invoice.</p>
<h2>What about fees paid by a student to a library?</h2>
<p>Fees that students pay to a library belong to that library. Each library decides its own refund rules, and refunds are recorded by the library with a reason. DDdesk does not decide a library's refunds to its students.</p>
<h2>Need help?</h2>
<p>Use the <a href="/contact">Contact</a> page and tell us your library name and the mobile number on the account.</p>`,
    },
};
