from io import BytesIO
from pathlib import Path
import base64
import json
from zipfile import ZipFile, ZIP_DEFLATED

from docx import Document
from docx.opc.constants import RELATIONSHIP_TYPE
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches
from pptx import Presentation
from pptx.util import Inches as SlideInches
from PIL import Image
import xlsxwriter

root = Path(__file__).parent
image = BytesIO()
Image.new("RGB", (48, 32), "#278a63").save(image, format="PNG")
png = image.getvalue()

document = Document()
document.add_heading("Document preview", level=1)
paragraph = document.add_paragraph("A paragraph with ")
paragraph.add_run("bold text").bold = True
paragraph.add_run(" and ")
paragraph.add_run("italic text").italic = True
document.add_paragraph("First item", style="List Bullet")
document.add_paragraph("Second item", style="List Bullet")
table = document.add_table(rows=2, cols=2)
table.cell(0, 0).text = "Name"
table.cell(0, 1).text = "Value"
table.cell(1, 0).text = "Document cell"
table.cell(1, 1).text = "42"
document.add_picture(BytesIO(png), width=Inches(1))
remote = document.part.relate_to(
    "https://document-preview.invalid/remote.png",
    RELATIONSHIP_TYPE.IMAGE,
    is_external=True,
)
paragraph = document.add_paragraph()
run = paragraph.add_run()
drawing = OxmlElement("w:drawing")
blip = OxmlElement("a:blip")
blip.set(qn("r:link"), remote)
drawing.append(blip)
run._r.append(drawing)
document.save(root / "preview.docx")

presentation = Presentation()
for title in ["Presentation preview", "Second slide"]:
    slide = presentation.slides.add_slide(presentation.slide_layouts[5])
    slide.shapes.title.text = title
    slide.shapes.add_picture(BytesIO(png), SlideInches(1), SlideInches(2))
presentation.save(root / "preview.pptx")
limited_slides = Presentation()
for index in range(140):
    slide = limited_slides.slides.add_slide(limited_slides.slide_layouts[5])
    slide.shapes.title.text = f"Limited slide {index + 1}"
limited_slides.save(root / "limits.pptx")

book = xlsxwriter.Workbook(root / "preview.xlsx")
for name in ["Summary", "Details"]:
    sheet = book.add_worksheet(name)
    sheet.write_row(0, 0, ["Item", "Value"])
    sheet.write_row(1, 0, [name + " cell", 42])
    if name == "Summary":
        sheet.write(2, 0, "x" * 520)
    sheet.write(200, 0, "Hidden row 201")
    sheet.write(1233, 0, "Hidden row 1,234")
    sheet.write(0, 30, "Hidden column AE")
book.close()

(root / "preview.csv").write_text('Item,Value\n"CSV cell",42\n')
(root / "preview.tsv").write_text("Item\tValue\nTSV cell\t42\n")
(root / "preview.ipynb").write_text(json.dumps({
    "nbformat": 4,
    "nbformat_minor": 5,
    "metadata": {"kernelspec": {"name": "python3", "language": "python"}},
    "cells": [
        {"cell_type": "markdown", "metadata": {}, "source": ["# Notebook preview\n", "**Markdown cell**"]},
        {"cell_type": "code", "metadata": {}, "execution_count": 1,
         "source": ["print('Notebook output')"],
         "outputs": [
             {"output_type": "stream", "name": "stdout", "text": ["Notebook output\n"]},
             {"output_type": "display_data", "metadata": {}, "data": {"image/png": base64.b64encode(png).decode()}},
             {"output_type": "display_data", "metadata": {}, "data": {"text/html": [
                 '<b>HTML output</b><script>window.parent.document.body.dataset.documentScript="executed"</script>',
                 '<img src="https://document-preview.invalid/remote.png" onerror="window.parent.document.body.dataset.documentScript=1">',
                 '<iframe src="https://document-preview.invalid/frame"></iframe>',
                 '<style>@import url("https://document-preview.invalid/style");</style>',
                 '<a href="https://document-preview.invalid/link">Untrusted link</a>',
             ]}},
         ]},
    ],
}))
(root / "limits.ipynb").write_text(json.dumps({
    "nbformat": 4,
    "nbformat_minor": 5,
    "metadata": {},
    "worksheets": [{"cells": [
        {"cell_type": "code", "metadata": {}, "prompt_number": index + 1,
         "input": [f"legacy_worksheet_cell_{index} = {index}"], "outputs": []}
        for index in range(count)
    ]} for count in [1, 201]],
    "cells": [
        {"cell_type": "code", "metadata": {}, "execution_count": index + 1,
         "source": [f"limited_cell_{index} = {index}"],
         "outputs": [
             {"output_type": "display_data", "metadata": {}, "data": {"text/plain": [f"Limited output {output}"]}}
             for output in range(51)
         ] if index == 0 else []}
        for index in range(260)
    ],
}))
with ZipFile(root / "expanded.docx", "w", ZIP_DEFLATED) as archive:
    archive.writestr("word/document.xml", b"x" * (25 * 1024 * 1024))
