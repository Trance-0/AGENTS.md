"""Create the dashboard's GitHub Pipeline-from-SCM job; credentials stay in env."""
from __future__ import annotations

import argparse
import base64
import http.cookiejar
import json
import os
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8081/")
    parser.add_argument("--branch", default="ai-infra-v0")
    args = parser.parse_args()
    username = os.environ.get("JENKINS_USER", "admin")
    password = os.environ["JENKINS_PASSWORD"]
    auth = "Basic " + base64.b64encode(f"{username}:{password}".encode()).decode()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    crumb = {}

    def request(path, data=None):
        headers = {"Authorization": auth}
        if data is not None:
            headers.update(crumb)
            headers["Content-Type"] = "application/xml"
        with opener.open(urllib.request.Request(args.url.rstrip("/") + "/" + path, data=data, headers=headers), timeout=30) as response:
            return response.read()

    identity = json.loads(request("whoAmI/api/json"))
    if not identity.get("authenticated"):
        raise RuntimeError("Job cannot be configured: dashboard/Jenkins authentication — supplied account is not authenticated.")
    csrf = json.loads(request("crumbIssuer/api/json"))
    crumb[csrf["crumbRequestField"]] = csrf["crumb"]
    root = ET.Element("flow-definition", {"plugin": "workflow-job"})
    ET.SubElement(root, "description").text = "GitHub push → remote checkout → versioned image and tests → state backup → dashboard deployment. Runtime secrets stay private on local-docker."
    ET.SubElement(root, "keepDependencies").text = "false"
    props = ET.SubElement(root, "properties")
    trigger_property = ET.SubElement(props, "org.jenkinsci.plugins.workflow.job.properties.PipelineTriggersJobProperty")
    trigger = ET.SubElement(ET.SubElement(trigger_property, "triggers"), "com.cloudbees.jenkins.GitHubPushTrigger", {"plugin": "github"})
    ET.SubElement(trigger, "spec")
    definition = ET.SubElement(root, "definition", {"class": "org.jenkinsci.plugins.workflow.cps.CpsScmFlowDefinition", "plugin": "workflow-cps"})
    scm = ET.SubElement(definition, "scm", {"class": "hudson.plugins.git.GitSCM", "plugin": "git"})
    ET.SubElement(scm, "configVersion").text = "2"
    remote = ET.SubElement(ET.SubElement(scm, "userRemoteConfigs"), "hudson.plugins.git.UserRemoteConfig")
    ET.SubElement(remote, "url").text = "https://github.com/Trance-0/AGENTS.md.git"
    ET.SubElement(ET.SubElement(ET.SubElement(scm, "branches"), "hudson.plugins.git.BranchSpec"), "name").text = f"*/{args.branch}"
    ET.SubElement(scm, "doGenerateSubmoduleConfigurations").text = "false"
    ET.SubElement(scm, "submoduleCfg", {"class": "empty-list"})
    ET.SubElement(scm, "extensions")
    ET.SubElement(definition, "scriptPath").text = "dashboard/Jenkinsfile"
    ET.SubElement(definition, "lightweight").text = "false"
    ET.SubElement(root, "disabled").text = "false"
    try:
        existing = request("job/agent-dashboard/config.xml")
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
        existing = None
    if existing:
        backup = Path("logs/jenkins-agent-dashboard-before.xml")
        backup.parent.mkdir(exist_ok=True)
        if not backup.exists():
            backup.write_bytes(existing)
            backup.chmod(0o600)
        request("job/agent-dashboard/config.xml", ET.tostring(root))
    else:
        request("createItem?name=agent-dashboard", ET.tostring(root))
    installed = ET.fromstring(request("job/agent-dashboard/config.xml"))
    assert installed.findtext("definition/scriptPath") == "dashboard/Jenkinsfile"
    assert installed.findtext("definition/scm/branches/hudson.plugins.git.BranchSpec/name") == f"*/{args.branch}"
    print("Job configured: dashboard/Jenkins SCM — GitHub remote branch, dashboard/Jenkinsfile, and push trigger verified.")


if __name__ == "__main__":
    main()
