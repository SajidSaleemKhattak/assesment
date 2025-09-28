const fs = require("fs");
const path = require("path");

function parseResume(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  return {
    // Preferred structured fields
    firstName: data.firstName || data.givenName || (data.name && data.name.split(" ")[0]) || "",
    middleName: data.middleName || data.tussenvoegsel || "",
    lastName:
      data.lastName ||
      data.familyName ||
      (data.name && data.name.split(" ").slice(1).join(" ")) ||
      "",
    email: data.email || data.mail || "",
    phone: data.phone || data.telefoon || data.mobile || "",
    postalCode: data.postalCode || data.zipCode || data.postcode || "",
    city: data.city || data.woonplaats || data.plaats || "",
    motivation: data.motivation || data.coverLetter || data.toelichting || "",
    cvFile: data.cvFile || data.cv || data.resumeFile || "",
    // Keep original fields for any other consumers
    name: data.name || "",
    skills: data.skills || [],
  };
}

module.exports = parseResume;
